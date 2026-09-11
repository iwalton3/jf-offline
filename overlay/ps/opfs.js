/* Origin private file system access for the phantom server's media bytes.
 *
 * Reads happen in the service worker, writes in the page. Both contexts load this
 * same file; see ps/schema.js for why it is a classic script.
 *
 * Media does not go in IndexedDB. A multi-gigabyte value there has to be
 * materialised whole to be read, which is exactly what a ranged video request
 * must not do.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;

    const root = () => navigator.storage.getDirectory();

    /** Walk (and optionally create) a directory chain under the phantom root. */
    async function dir(parts, create) {
        let d = await root();
        d = await d.getDirectoryHandle(S.OPFS_ROOT, { create: !!create });
        for (const part of parts) {
            d = await d.getDirectoryHandle(part, { create: !!create });
        }
        return d;
    }

    /** Split a path array into its directory chain and file name. */
    const split = (path) => [path.slice(0, -1), path[path.length - 1]];

    async function fileHandle(path, create) {
        const [dirs, name] = split(path);
        const d = await dir(dirs, create);
        return d.getFileHandle(name, { create: !!create });
    }

    /** The File, or null when it is not held. Callers use null as "not downloaded". */
    async function file(path) {
        try {
            return await (await fileHandle(path, false)).getFile();
        } catch (err) {
            if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return null;
            throw err;
        }
    }

    async function exists(path) {
        return (await file(path)) !== null;
    }

    async function writeBlob(path, blob) {
        const handle = await fileHandle(path, true);
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return blob.size;
    }

    /**
     * Stream a response body to a file, reporting progress.
     *
     * Written through a single writable rather than accumulated in memory, because
     * the whole point of this path is files too large to hold.
     */
    async function writeStream(path, response, onProgress) {
        const handle = await fileHandle(path, true);
        const w = await handle.createWritable();
        let written = 0;
        try {
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                await w.write(value);
                written += value.byteLength;
                if (onProgress) onProgress(written);
            }
            await w.close();
        } catch (err) {
            // Leaving a truncated file behind would look downloaded to every later
            // read. abort() discards what was written.
            try { await w.abort(); } catch { /* the failure above is the real one */ }
            throw err;
        }
        return written;
    }

    async function removeDir(parts) {
        const [dirs, name] = split(parts);
        try {
            const d = await dir(dirs, false);
            await d.removeEntry(name, { recursive: true });
        } catch (err) {
            if (!err || err.name !== 'NotFoundError') throw err;
        }
    }

    async function usage() {
        const est = await navigator.storage.estimate();
        return { usage: est.usage || 0, quota: est.quota || 0 };
    }

    g.PS_OPFS = { dir, fileHandle, file, exists, writeBlob, writeStream, removeDir, usage };
})(self);
