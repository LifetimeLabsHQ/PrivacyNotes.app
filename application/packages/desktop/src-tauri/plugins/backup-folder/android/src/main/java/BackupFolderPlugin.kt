package app.privacynotes.backupfolder

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.provider.DocumentsContract
import android.system.ErrnoException
import android.system.OsConstants
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.concurrent.Executors

@InvokeArg
class PlaceArgs {
    var stagingPath: String = ""
    var name: String = ""
}

@InvokeArg
class RefArgs {
    var ref: String = ""
}

/**
 * The backup folder on Android.
 *
 * The person picks a folder with the system picker (Storage Access
 * Framework). The app keeps the tree URI and a persisted read and write
 * permission for it, and nothing else: it can reach that folder and no other
 * place on the device. A backup is a new document in the tree, filled from
 * the staging file in the app's cache directory and then read back, so the
 * Rust side (src/backup_dest.rs) can compare what the provider stored with
 * what it staged. A provider may rename a new document, so a placed file is
 * known by its document URI, never by its name.
 *
 * Reached from Rust only; the web view holds no permission for this plugin.
 * Rejections carry one code: `no-destination`, `bad-name`, `gone`, `denied`,
 * `full` or `io`.
 * Spec: docs/internal/plans/auto-backup.md (section 7)
 */
@TauriPlugin
class BackupFolderPlugin(private val activity: Activity) : Plugin(activity) {
    private val worker = Executors.newSingleThreadExecutor()
    private val resolver get() = activity.contentResolver
    private val prefs get() = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Command
    fun pick(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
            startActivityForResult(invoke, intent, "pickResult")
        } catch (e: Exception) {
            invoke.reject("No folder picker", IO)
        }
    }

    @ActivityCallback
    fun pickResult(invoke: Invoke, result: ActivityResult) {
        val tree = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || tree == null) {
            val ret = JSObject()
            ret.put("picked", false)
            return invoke.resolve(ret)
        }
        try {
            resolver.takePersistableUriPermission(tree, RW)
        } catch (e: Exception) {
            return invoke.reject("The folder cannot be kept", DENIED)
        }
        // The result arrives on the main thread, and a provider can be slow.
        worker.execute {
            // The folder picked before is given back: earlier backups stay
            // in it, and this app stops reaching it.
            storedTree()?.takeIf { it != tree }?.let { old -> runCatching { resolver.releasePersistableUriPermission(old, RW) } }
            val label = displayName(treeDocument(tree)) ?: tree.lastPathSegment ?: ""
            prefs.edit().putString(KEY_TREE, tree.toString()).putString(KEY_LABEL, label).apply()
            val ret = JSObject()
            ret.put("picked", true)
            ret.put("label", label)
            invoke.resolve(ret)
        }
    }

    @Command
    fun status(invoke: Invoke) {
        worker.execute {
            val ret = JSObject()
            val tree = storedTree()
            ret.put("stored", tree != null)
            if (tree != null) {
                ret.put("label", prefs.getString(KEY_LABEL, "") ?: "")
                ret.put("reachable", reachable(tree))
            }
            invoke.resolve(ret)
        }
    }

    @Command
    fun place(invoke: Invoke) {
        val args = invoke.parseArgs(PlaceArgs::class.java)
        worker.execute {
            val tree = storedTree() ?: return@execute invoke.reject("No folder", NO_DESTINATION)
            if (!NAME.matches(args.name)) return@execute invoke.reject("Bad name", BAD_NAME)
            // Only the staging file of src/backup_dest.rs is ever copied out.
            val staging = File(args.stagingPath)
            val cache = activity.cacheDir.canonicalPath + File.separator
            if (!staging.canonicalPath.startsWith(cache)) return@execute invoke.reject("Bad staging file", IO)
            if (!reachable(tree)) return@execute invoke.reject("Folder unreachable", GONE)
            var document: Uri? = null
            try {
                val made = DocumentsContract.createDocument(resolver, treeDocument(tree), MIME, args.name)
                    ?: throw FileNotFoundException("no document")
                document = made
                FileInputStream(staging).use { input ->
                    (resolver.openOutputStream(made, "w") ?: throw FileNotFoundException("no stream")).use { output ->
                        input.copyTo(output, BUFFER)
                        output.flush()
                    }
                }
                // What the provider holds now, not what was sent to it.
                val digest = MessageDigest.getInstance("SHA-256")
                var bytes = 0L
                (resolver.openInputStream(made) ?: throw FileNotFoundException("no stream")).use { input ->
                    val buffer = ByteArray(BUFFER)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        digest.update(buffer, 0, read)
                        bytes += read
                    }
                }
                val ret = JSObject()
                ret.put("ref", made.toString())
                ret.put("name", displayName(made) ?: args.name)
                ret.put("bytes", bytes)
                ret.put("sha256", digest.digest().joinToString("") { "%02x".format(it) })
                invoke.resolve(ret)
            } catch (e: Exception) {
                document?.let { runCatching { DocumentsContract.deleteDocument(resolver, it) } }
                invoke.reject("Not placed", codeFor(e))
            }
        }
    }

    @Command
    fun exists(invoke: Invoke) {
        val args = invoke.parseArgs(RefArgs::class.java)
        worker.execute {
            val document = ownDocument(invoke, args.ref) ?: return@execute
            val ret = JSObject()
            ret.put("value", present(document))
            invoke.resolve(ret)
        }
    }

    @Command
    fun delete(invoke: Invoke) {
        val args = invoke.parseArgs(RefArgs::class.java)
        worker.execute {
            val document = ownDocument(invoke, args.ref) ?: return@execute
            val ret = JSObject()
            if (!present(document)) {
                ret.put("value", false)
                return@execute invoke.resolve(ret)
            }
            try {
                if (!DocumentsContract.deleteDocument(resolver, document)) return@execute invoke.reject("Not deleted", IO)
                ret.put("value", true)
                invoke.resolve(ret)
            } catch (e: FileNotFoundException) {
                ret.put("value", false)
                invoke.resolve(ret)
            } catch (e: Exception) {
                invoke.reject("Not deleted", codeFor(e))
            }
        }
    }

    @Command
    fun clear(invoke: Invoke) {
        storedTree()?.let { tree -> runCatching { resolver.releasePersistableUriPermission(tree, RW) } }
        prefs.edit().remove(KEY_TREE).remove(KEY_LABEL).apply()
        invoke.resolve()
    }

    @Command
    fun metered(invoke: Invoke) {
        val ret = JSObject()
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        // Unknown counts as metered: the careful answer for "only on Wi-Fi".
        ret.put("value", runCatching { manager?.isActiveNetworkMetered }.getOrNull() ?: true)
        invoke.resolve(ret)
    }

    private fun storedTree(): Uri? = prefs.getString(KEY_TREE, null)?.let { runCatching { Uri.parse(it) }.getOrNull() }

    /** The document that stands for the tree's own folder. */
    private fun treeDocument(tree: Uri): Uri =
        DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

    /** The permission is still held, and the folder is still there. */
    private fun reachable(tree: Uri): Boolean {
        val held = resolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission && it.isWritePermission }
        return held && present(treeDocument(tree))
    }

    /** Whether the provider has a row for the document. */
    private fun present(document: Uri): Boolean = try {
        resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)
            ?.use { it.moveToFirst() } ?: false
    } catch (e: Exception) {
        false
    }

    private fun displayName(document: Uri): String? = try {
        resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    } catch (e: Exception) {
        null
    }

    /** The name and MIME type of a document, or null when it is not there. */
    private fun nameAndType(document: Uri): Pair<String?, String?>? = try {
        resolver.query(
            document,
            arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE),
            null, null, null,
        )?.use { if (it.moveToFirst()) Pair(it.getString(0), it.getString(1)) else null }
    } catch (e: Exception) {
        null
    }

    /**
     * The document a reference names, when it lies in the stored tree: the
     * same provider and the same tree id, which is what makes the provider
     * check that the document is inside that tree. Anything else is
     * refused, and so is a tree that cannot be reached now, because a
     * folder that is away still holds its files. Rejects and answers null.
     */
    private fun ownDocument(invoke: Invoke, ref: String): Uri? {
        val tree = storedTree()
        if (tree == null) {
            invoke.reject("No folder", NO_DESTINATION)
            return null
        }
        val document = runCatching { Uri.parse(ref) }.getOrNull()
        val inside = document != null &&
            document.scheme == "content" &&
            document.authority == tree.authority &&
            DocumentsContract.isDocumentUri(activity, document) &&
            runCatching { DocumentsContract.getTreeDocumentId(document) }.getOrNull() == DocumentsContract.getTreeDocumentId(tree) &&
            DocumentsContract.getDocumentId(document) != DocumentsContract.getTreeDocumentId(tree)
        if (!inside) {
            invoke.reject("Not a file of this folder", BAD_NAME)
            return null
        }
        if (!reachable(tree)) {
            invoke.reject("Folder unreachable", GONE)
            return null
        }
        // Only a backup file of ours, as on desktop and iOS: never a folder,
        // never another file under the tree. A document that is gone passes
        // here, and the caller answers false for it.
        val info = nameAndType(document)
        if (info != null) {
            val (name, type) = info
            if (type == DocumentsContract.Document.MIME_TYPE_DIR) {
                invoke.reject("Not a backup file", DENIED)
                return null
            }
            if (name == null || !OWN_NAME.matches(name)) {
                invoke.reject("Not a backup file", BAD_NAME)
                return null
            }
        }
        return document
    }

    private fun codeFor(e: Throwable): String {
        var cause: Throwable? = e
        while (cause != null) {
            if (cause is ErrnoException && (cause.errno == OsConstants.ENOSPC || cause.errno == OsConstants.EDQUOT)) return FULL
            if (cause.message?.contains("ENOSPC") == true) return FULL
            cause = cause.cause
        }
        return when (e) {
            is SecurityException -> DENIED
            is FileNotFoundException -> GONE
            else -> IO
        }
    }

    private companion object {
        const val PREFS = "backup-folder"
        const val KEY_TREE = "tree"
        const val KEY_LABEL = "label"
        const val MIME = "application/octet-stream"
        const val BUFFER = 1 shl 16
        const val RW = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        const val NO_DESTINATION = "no-destination"
        const val BAD_NAME = "bad-name"
        const val GONE = "gone"
        const val DENIED = "denied"
        const val FULL = "full"
        const val IO = "io"
        // The same check as device_of in src/backup_dest.rs.
        // `matches` wants the whole name. `[0-9]`, because `\d` also takes
        // the digits of other scripts on Android.
        val NAME = Regex("privacynotes-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[a-z0-9-]{1,40}\\.(pnbackupz|pnbackup)")
        // A placed backup as the provider may have named it: NAME, or NAME
        // with " (1)" before the extension when the provider renamed it on
        // create. `exists` and `delete` take only these, so a caller cannot
        // reach any other file under the picked folder.
        val OWN_NAME = Regex("privacynotes-backup-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[a-z0-9-]{1,40}( \\([0-9]{1,4}\\))?\\.(pnbackupz|pnbackup)")
    }
}
