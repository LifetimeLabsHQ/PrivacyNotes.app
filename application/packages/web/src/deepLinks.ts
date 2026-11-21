import { parseShortcut } from './noteShortcut';

/**
 * The one listener of the deep-link plugin on a native build.
 *
 * The plugin emits every address the operating system opens the app with,
 * whoever it is for. Three handlers want some of them: the sign-in return
 * (`useOAuthFlows` in authOAuth.ts), the account connection on Android
 * (`beginAccountConnection` in accountConnection.ts) and the note shortcuts
 * (`useShortcutDeepLinks`). This module registers the plugin once, while at
 * least one handler listens, and hands each address to the one handler it
 * belongs to (`deepLinkOwner`). An address whose handler is not listening is
 * dropped. In one delivery each handler gets at most one address: the first
 * that is its own.
 *
 * Three ways in: `launch` is the address the app was started with, read once
 * for each handler that asks for it when it starts listening; `open` is an
 * address delivered to the running app; `resume` is the current address read
 * when the app comes back to the front, because Android delivers a return to
 * a running app without the `open` event. `getCurrent()` keeps answering the
 * same address, so a `launch` or a `resume` can be one the handler already
 * had; each handler decides that itself.
 *
 * Spec: docs/internal/plans/deep-link-callback-hardening.md (sections 2.2 and 3)
 * Test: tests/deepLinks.test.ts, tests/deepLinkRouting.test.ts.
 */
export type DeepLinkOwner = 'shortcut' | 'connection' | 'signIn';
export type DeepLinkWay = 'launch' | 'open' | 'resume';
export type DeepLinkTaker = (url: string, way: DeepLinkWay) => void;

/**
 * The handler an address belongs to. A note shortcut first (`parseShortcut`
 * is its only guard); then a connection return, which carries `pn_connect`
 * and must never reach the sign-in handler; everything else is the sign-in
 * handler's, which refuses what is not its own callback before it spends
 * anything.
 */
export function deepLinkOwner(url: string): DeepLinkOwner {
  if (parseShortcut(url)) return 'shortcut';
  try {
    if (new URL(url).searchParams.has('pn_connect')) return 'connection';
  } catch {
    /* not an address: the sign-in handler refuses it */
  }
  return 'signIn';
}

type Plugin = typeof import('@tauri-apps/plugin-deep-link');
type Entry = { owner: DeepLinkOwner; take: DeepLinkTaker };

const entries = new Set<Entry>();
let wiring: Promise<Plugin> | null = null;
let unwire: (() => void) | null = null;
let generation = 0;

function deliver(urls: readonly string[] | null | undefined, way: DeepLinkWay, only?: Entry): void {
  const present = (urls ?? []).filter((url): url is string => typeof url === 'string' && url !== '');
  const owned = present.map((url) => ({ url, owner: deepLinkOwner(url) }));
  for (const entry of only ? [only] : [...entries]) {
    if (!entries.has(entry)) continue;
    const mine = owned.find((item) => item.owner === entry.owner);
    if (!mine) continue;
    // One handler that throws must not skip the others, nor leave an
    // unhandled rejection on the resume path. The log names the handler
    // only: the address, and an error that may quote it, came from outside.
    try {
      entry.take(mine.url, way);
    } catch {
      console.error('Deep-link handler failed:', entry.owner);
    }
  }
}

function wire(): Promise<Plugin> {
  if (wiring) return wiring;
  const mine = ++generation;
  wiring = (async () => {
    const plugin = await import('@tauri-apps/plugin-deep-link');
    const unlisten = await plugin.onOpenUrl((urls) => deliver(urls, 'open'));
    if (mine !== generation) {
      unlisten();
      return plugin;
    }
    const onResume = () => {
      if (document.hidden) return;
      plugin.getCurrent().then((urls) => deliver(urls, 'resume'), () => {
        /* transient plugin failure: the next resume asks again */
      });
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    unwire = () => {
      unlisten();
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
    return plugin;
  })();
  wiring.catch((e) => {
    console.error('Deep-link listener setup failed:', e);
    if (mine === generation) wiring = null;
  });
  return wiring;
}

function stopWhenEmpty(): void {
  if (entries.size > 0) return;
  generation++;
  wiring = null;
  unwire?.();
  unwire = null;
}

/**
 * Start handing `owner`'s addresses to `take`. With `launch`, the address the
 * app was started with comes first, if it is `owner`'s. `ready` settles once
 * the plugin listens (it rejects when the plugin cannot), so a caller that
 * opens a browser can wait for it first. `stop` ends this handler's turn;
 * the last one to stop unregisters the plugin.
 */
export function takeDeepLinks(
  owner: DeepLinkOwner,
  take: DeepLinkTaker,
  options: { launch?: boolean } = {},
): { ready: Promise<void>; stop: () => void } {
  const entry: Entry = { owner, take };
  entries.add(entry);
  const plugin = wire();
  const ready = plugin.then(() => undefined);
  // A caller that does not wait for `ready` must not see an unhandled
  // rejection; one that waits still gets it.
  ready.catch(() => {});
  if (options.launch) {
    void plugin.then(async (p) => {
      if (!entries.has(entry)) return;
      deliver(await p.getCurrent(), 'launch', entry);
    }).catch(() => {
      /* logged by wire(), or the launch address could not be read */
    });
  }
  return {
    ready,
    stop: () => {
      if (!entries.delete(entry)) return;
      stopWhenEmpty();
    },
  };
}
