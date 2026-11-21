// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    io::{BufWriter, Error, ErrorKind, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
};

use crate::SingleInstanceCallback;
#[cfg(feature = "semver")]
use crate::semver_compat::semver_compat_string;
use tauri::{
    AppHandle, Manager, RunEvent, Runtime,
    plugin::{self, TauriPlugin},
};
use tokio::io::AsyncReadExt;

pub fn init<R: Runtime>(cb: Box<SingleInstanceCallback<R>>) -> TauriPlugin<R> {
    plugin::Builder::new("single-instance")
        .setup(|app, _api| {
            let Some(socket) = socket_path(app) else {
                tracing::debug!("single_instance found no app data folder - launching normally");
                return Ok(());
            };

            // Notify the singleton which may or may not exist.
            match notify_singleton(&socket) {
                Ok(_) => {
                    std::process::exit(0);
                }
                Err(e) => {
                    match e.kind() {
                        ErrorKind::NotFound | ErrorKind::ConnectionRefused => {
                            // This process claims itself as singleton as likely none exists
                            socket_cleanup(&socket);
                            listen_for_other_instances(socket, app.clone(), cb);
                        }
                        _ => {
                            tracing::debug!(
                                "single_instance failed to notify - launching normally: {}",
                                e
                            );
                        }
                    }
                }
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                destroy(app);
            }
        })
        .build()
}

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Some(socket) = socket_path(manager) {
        socket_cleanup(&socket);
    }
}

// PrivacyNotes patch: the socket lives in this app's own data folder
// (~/Library/Application Support/<identifier>/), not in `/tmp`. `/tmp` is
// shared by every account on the Mac, and this plugin treats whatever answers
// at the socket as the running app: it hands it this launch's arguments and
// working directory, then exits. In the app's own folder only this user can
// create the socket. A path past the 104-byte socket limit (a very long home
// folder) fails to connect and to bind, which the code above already handles
// by launching normally without second-launch forwarding, and so does a
// missing data folder: there is no shared fallback.
fn socket_path<R: Runtime, M: Manager<R>>(manager: &M) -> Option<PathBuf> {
    let dir = manager.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(socket_path_in(dir, manager.package_info()))
}

fn socket_path_in(dir: PathBuf, _package_info: &tauri::PackageInfo) -> PathBuf {
    #[cfg(feature = "semver")]
    let name = format!("si_{}.sock", semver_compat_string(&_package_info.version));
    #[cfg(not(feature = "semver"))]
    let name = String::from("si.sock");

    dir.join(name)
}

fn socket_cleanup(socket: &PathBuf) {
    let _ = std::fs::remove_file(socket);
}

fn notify_singleton(socket: &PathBuf) -> Result<(), Error> {
    let stream = UnixStream::connect(socket)?;
    let mut bf = BufWriter::new(&stream);
    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_str()
        .unwrap_or_default()
        .to_string();
    bf.write_all(cwd.as_bytes())?;
    bf.write_all(b"\0\0")?;
    let args_joined = std::env::args().collect::<Vec<String>>().join("\0");
    bf.write_all(args_joined.as_bytes())?;
    bf.flush()?;
    drop(bf);
    Ok(())
}

fn listen_for_other_instances<A: Runtime>(
    socket: PathBuf,
    app: AppHandle<A>,
    mut cb: Box<SingleInstanceCallback<A>>,
) {
    tauri::async_runtime::spawn(async move {
        match tokio::net::UnixListener::bind(socket) {
            Ok(listener) => loop {
                match listener.accept().await {
                    Ok((mut stream, _addr)) => {
                        let mut s = String::new();
                        match stream.read_to_string(&mut s).await {
                            Ok(_) => {
                                let (cwd, args) = s.split_once("\0\0").unwrap_or_default();
                                let args: Vec<String> =
                                    args.split('\0').map(String::from).collect();
                                cb(app.app_handle(), args, cwd.to_string());
                            }
                            Err(e) => {
                                tracing::debug!("single_instance failed to be notified: {e}")
                            }
                        }
                    }
                    Err(err) => {
                        tracing::debug!("single_instance failed to be notified: {}", err);
                        continue;
                    }
                }
            },
            Err(err) => {
                tracing::error!(
                    "single_instance failed to listen to other processes - launching normally: {}",
                    err
                );
            }
        }
    });
}
