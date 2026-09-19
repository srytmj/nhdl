const fs = require('fs');
const path = require('path');
const { sanitizeName, atomicWriteFileSync } = require('./utils');
const { buildZip } = require('./zip');

const ROOT_DIR = path.resolve(__dirname, '..');
// Live inside the active download dir (a persistent volume) instead of ROOT_DIR (the
// container's writable layer, wiped on every image rebuild) — see setStateDir().
let DEFAULT_LIBRARY_FILE = path.join(ROOT_DIR, 'library.json');
let DEFAULT_ERROR_LOG = path.join(ROOT_DIR, 'error.log');

function setStateDir(dir) {
    if (!dir) return;
    DEFAULT_LIBRARY_FILE = path.join(dir, 'library.json');
    DEFAULT_ERROR_LOG = path.join(dir, 'error.log');
}

function loadLibrary(libFile = DEFAULT_LIBRARY_FILE) {
    if (fs.existsSync(libFile)) {
        try {
            return JSON.parse(fs.readFileSync(libFile, 'utf-8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

const MARKER_FILENAME = '.nhdl-id';

function saveToLibrary(id, title, folder, pages, ext, pageExts = {}, extra = {}, libFile = DEFAULT_LIBRARY_FILE) {
    try {
        const library = loadLibrary(libFile);
        library[id] = {
            title,
            folder,
            pages,
            ext,
            pageExts,
            author: extra.author || null,
            lang: extra.lang || null,
            downloadedAt: new Date().toISOString()
        };
        atomicWriteFileSync(libFile, JSON.stringify(library, null, 2));

        // Drop a tiny marker file carrying the gallery ID inside its own folder. If the
        // user later moves/renames the folder outside the app, rescanLibrary() can still
        // find it again — the marker travels with the folder, no need to match by name.
        try { fs.writeFileSync(path.join(folder, MARKER_FILENAME), id.toString(), 'utf-8'); } catch (e) {}
    } catch (e) {
        console.error("Failed to save to library.json:", e.message);
    }
}

// Registers an already-compressed .cbz/.zip found on disk (e.g. adopted from a leftover
// archive with no library.json entry) as a completed download — no marker file, since a
// zip can't hold one without unpacking it, but the archive itself is proof of completion.
function saveArchivedToLibrary(id, title, archivePath, archiveExt, extra = {}, libFile = DEFAULT_LIBRARY_FILE) {
    try {
        const library = loadLibrary(libFile);
        library[id] = {
            title,
            folder: archivePath,
            pages: extra.pages || 0,
            ext: null,
            pageExts: {},
            author: extra.author || null,
            lang: extra.lang || null,
            downloadedAt: new Date().toISOString(),
            archived: true,
            archiveExt
        };
        atomicWriteFileSync(libFile, JSON.stringify(library, null, 2));
    } catch (e) {
        console.error("Failed to save archived entry to library.json:", e.message);
    }
}

// One-shot, on-demand filesystem walk (NOT a background/interval job — call this only
// when the user asks, e.g. a "Rescan" button, or once at server startup) that reconciles
// library.json against what's actually on disk using the .nhdl-id marker files. Depth is
// bounded so a single scan stays cheap even for large libraries.
function rescanLibrary(baseDownloadDir, libFile = DEFAULT_LIBRARY_FILE) {
    const result = { scanned: 0, relocated: 0, unchanged: 0, pruned: 0 };
    if (!baseDownloadDir || !fs.existsSync(baseDownloadDir)) return result;

    const library = loadLibrary(libFile);
    const MAX_DEPTH = 6;
    const stack = [{ dir: baseDownloadDir, depth: 0 }];

    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        let dirents;
        try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }

        const hasMarker = dirents.some(d => d.isFile() && d.name === MARKER_FILENAME);
        if (hasMarker) {
            result.scanned++;
            try {
                const id = fs.readFileSync(path.join(dir, MARKER_FILENAME), 'utf-8').trim();
                if (id && library[id]) {
                    if (library[id].folder !== dir) {
                        library[id] = { ...library[id], folder: dir, legacy: false };
                        result.relocated++;
                    } else {
                        result.unchanged++;
                    }
                }
            } catch (e) {}
            continue; // gallery folders don't nest further galleries
        }

        if (depth < MAX_DEPTH) {
            for (const d of dirents) {
                if (d.isDirectory()) stack.push({ dir: path.join(dir, d.name), depth: depth + 1 });
            }
        }
    }

    // Cheap second pass: for entries whose folder is still exactly where library.json says
    // (never moved) but that predate the marker-file feature, drop a marker in now — bounded
    // by the number of library entries, no extra directory walking needed. Entries that are
    // STILL not backed by any real folder/file after the walk above (e.g. ancient "legacy"
    // stubs, or content moved outside the tracked download dir) get pruned, so the Library
    // panel only ever reflects what's actually on disk right now.
    let changed = result.relocated > 0;
    for (const id of Object.keys(library)) {
        const entry = library[id];
        if (entry.folder && fs.existsSync(entry.folder)) {
            const markerPath = path.join(entry.folder, MARKER_FILENAME);
            if (!fs.existsSync(markerPath)) {
                try { fs.writeFileSync(markerPath, id.toString(), 'utf-8'); } catch (e) {}
            }
        } else {
            delete library[id];
            result.pruned++;
            changed = true;
        }
    }

    if (changed) {
        atomicWriteFileSync(libFile, JSON.stringify(library, null, 2));
    }
    return result;
}

// Looks up which output format ("folder" | "cbz" | "zip") a gallery's batch was tagged
// with when it was inserted (see the "# BATCH N FORMAT=x" marker written by the Insert
// Target dropdown). Defaults to "folder" for batches that predate this feature.
function getBatchFormatForGallery(listPath, galleryId) {
    if (!listPath || !fs.existsSync(listPath)) return 'folder';
    try {
        const lines = fs.readFileSync(listPath, 'utf-8').split('\n');
        let currentFormat = 'folder';
        for (const line of lines) {
            const batchMatch = line.match(/^#\s*BATCH\s+\d+(?:\s+FORMAT=(\w+))?/i);
            if (batchMatch) {
                currentFormat = batchMatch[1] ? batchMatch[1].toLowerCase() : 'folder';
                continue;
            }
            const idMatch = line.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b/);
            if (idMatch && idMatch[1] === galleryId.toString()) {
                return currentFormat;
            }
        }
    } catch (e) {}
    return 'folder';
}

// Builds the fuller display name shown in the queue (title + artist/group), falling
// back gracefully when the author is unknown/generic.
function buildDisplayName(title, author) {
    if (author && author !== 'Other' && author !== 'Unknown') {
        return `${author} - ${title}`;
    }
    return title;
}

// Reverses buildDisplayName() using whatever a previous successful run already wrote into
// list.txt (e.g. "Kazuhiro - Gal's Bitch Shijou Shugi!"). Lets processGallery check disk
// for an already-downloaded file using a cached title WITHOUT hitting the network first —
// the one case that matters is exactly a Cloudflare 429 blocking a fresh metadata fetch for
// a gallery whose library.json entry was lost but whose file is still sitting on disk.
function getCachedDisplayName(listPath, galleryId) {
    if (!listPath || !fs.existsSync(listPath)) return null;
    try {
        const lines = fs.readFileSync(listPath, 'utf-8').split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('#') || line.trim() === '') continue;
            const m = line.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b[^|]*\|\s*(.+)$/);
            if (m && m[1] === galleryId.toString()) {
                const full = m[2].trim();
                const sepIdx = full.indexOf(' - ');
                if (sepIdx > 0) {
                    return { author: full.slice(0, sepIdx), title: full.slice(sepIdx + 3) };
                }
                return { author: null, title: full };
            }
        }
    } catch (e) {}
    return null;
}

// Rewrites the raw list.txt line for a gallery ID with a fuller display name
// (title + artist/group), once we actually have that metadata — reuses data already
// fetched during the normal download flow, so this never triggers an extra network request.
function updateListDisplayName(listPath, galleryId, displayName) {
    if (!listPath || !fs.existsSync(listPath)) return;
    try {
        const content = fs.readFileSync(listPath, 'utf-8');
        const lines = content.split('\n');
        let changed = false;
        const updated = lines.map(line => {
            if (line.trim().startsWith('#') || line.trim() === '') return line;
            const idMatch = line.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b/);
            if (idMatch && idMatch[1] === galleryId.toString()) {
                const newLine = `https://nhentai.net/g/${galleryId}/ | ${displayName}`;
                if (newLine !== line.trim()) changed = true;
                return newLine;
            }
            return line;
        });
        if (changed) atomicWriteFileSync(listPath, updated.join('\n'));
    } catch (e) {}
}

function trackerFileToListPath(trackerFile) {
    if (!trackerFile) return null;
    return trackerFile.replace(/_status\.txt$/, '.txt');
}

function isLibraryEntryValid(entry) {
    return !!(entry && entry.folder && fs.existsSync(entry.folder));
}

// A gallery whose link is permanently unusable (404, removed, blocked page we can't parse)
// gets marked here instead of a real download entry — isLibraryEntryValid() stays false for
// it (there's no folder/content), but isPermanentlySkipped() lets runBatch exclude it from
// pendingIds so it's not retried forever on every future run.
function isPermanentlySkipped(entry) {
    return !!(entry && entry.skipped === true);
}

function saveSkippedToLibrary(id, reason, libFile = DEFAULT_LIBRARY_FILE) {
    try {
        const library = loadLibrary(libFile);
        library[id] = { skipped: true, reason, skippedAt: new Date().toISOString() };
        atomicWriteFileSync(libFile, JSON.stringify(library, null, 2));
    } catch (e) {
        console.error("Failed to save skipped entry to library.json:", e.message);
    }
}

const MAX_ERROR_LOG_LINES = 200;

function logError(galleryId, message, errorLogFile = DEFAULT_ERROR_LOG) {
    const time = new Date().toISOString();
    const logLine = `[${time}] ID: ${galleryId} - ${message}`;
    try {
        fs.appendFileSync(errorLogFile, logLine + '\n', 'utf-8');

        // Keep error.log from growing forever — trim to the most recent entries so the
        // System Faults panel doesn't pile up with stale noise.
        const content = fs.readFileSync(errorLogFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim() !== '');
        if (lines.length > MAX_ERROR_LOG_LINES) {
            const trimmed = lines.slice(lines.length - MAX_ERROR_LOG_LINES);
            atomicWriteFileSync(errorLogFile, trimmed.join('\n') + '\n');
        }
    } catch (e) {
        // error.log itself couldn't be written (e.g. disk read-only) — fall back to
        // stdout so `docker logs` still has the error instead of it vanishing.
        console.error(`${logLine} [error.log write failed: ${e.code || e.message}]`);
    }
}

function syncListTracker(listPath, libFile = DEFAULT_LIBRARY_FILE) {
    let galleryIds = [];
    if (!fs.existsSync(listPath)) return null;

    const content = fs.readFileSync(listPath, 'utf-8');
    const lines = content.split('\n');
    let newStatusLines = [];

    const parsedPath = path.parse(listPath);
    const trackerFile = path.join(parsedPath.dir, parsedPath.name + "_status.txt");

    let oldStatuses = {};
    if (fs.existsSync(trackerFile)) {
        const oldContent = fs.readFileSync(trackerFile, 'utf-8');
        oldContent.split('\n').forEach(line => {
            const match = line.match(/^\[(.*?)\]\s*(.*)$/);
            if (match) {
                const status = match[1];
                const text = match[2].trim();
                const idMatch = text.match(/(?:nhentai\.net\/g\/|^)(\d+)\b/);
                if (idMatch) {
                    oldStatuses[idMatch[1]] = status;
                }
            }
        });
    }

    const library = loadLibrary(libFile);
    const seenIds = new Set();
    let newListLines = [];
    let listChanged = false;

    lines.forEach(line => {
        if (line.trim().startsWith('#') || line.trim() === '') {
            newStatusLines.push(line);
            newListLines.push(line);
            return;
        }

        const idMatch = line.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b/);
        if (idMatch) {
            const id = idMatch[1];

            // Same gallery ID pasted/synced more than once — keep only the first
            // occurrence so the queue doesn't show duplicate rows (and so the frontend's
            // keyed list doesn't choke on a repeated key).
            if (seenIds.has(id)) {
                listChanged = true;
                return;
            }
            seenIds.add(id);

            let status = "PENDING";
            let outLine = line;
            if (library[id] && isLibraryEntryValid(library[id])) {
                status = "DONE";
                // Backfill the display name for galleries that finished before this list line
                // ever got a full title written to it — reuses the title/author already saved
                // in library.json from the original download, so this is still zero extra requests.
                const displayName = buildDisplayName(library[id].title, library[id].author);
                const enriched = `https://nhentai.net/g/${id}/ | ${displayName}`;
                if (enriched !== line.trim()) {
                    outLine = enriched;
                    listChanged = true;
                }
            } else if (oldStatuses[id]) {
                status = oldStatuses[id];
                if (status === "ON_PROGRESS" || status === "DONE") status = "PENDING";
            }

            newStatusLines.push(`[${status}] ${outLine.trim()}`);
            newListLines.push(outLine);
            galleryIds.push(id);
        } else {
            newStatusLines.push(line);
            newListLines.push(line);
        }
    });

    atomicWriteFileSync(trackerFile, newStatusLines.join('\n'));
    if (listChanged) {
        atomicWriteFileSync(listPath, newListLines.join('\n'));
    }
    return { galleryIds, trackerFile };
}

function updateListStatus(trackerFile, galleryId, newStatus) {
    if (!trackerFile || !fs.existsSync(trackerFile)) return;
    try {
        const content = fs.readFileSync(trackerFile, 'utf-8');
        const lines = content.split('\n');
        const updatedLines = lines.map(line => {
            const match = line.match(/^\[(.*?)\]\s*(.*)$/);
            if (match) {
                const text = match[2];
                const idMatch = text.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b/);
                if (idMatch && idMatch[1] === galleryId.toString()) {
                    return `[${newStatus}] ${text}`;
                }
            }
            return line;
        });
        atomicWriteFileSync(trackerFile, updatedLines.join('\n'));
    } catch (e) {}
}

// Renames a gallery's folder (or, if already archived, its .cbz file) on disk and keeps
// library.json + the visible list.txt line in sync — so the user never has to touch
// Explorer directly. Works purely with fs.renameSync (no copy), so it's instant even for
// large galleries.
function renameLibraryEntry(id, newTitle, libFile = DEFAULT_LIBRARY_FILE, listFile = null) {
    const library = loadLibrary(libFile);
    const entry = library[id];
    if (!entry || !entry.folder || !fs.existsSync(entry.folder)) {
        return { success: false, error: 'Gallery not found or its folder is missing' };
    }

    const trimmedTitle = (newTitle || '').trim();
    if (!trimmedTitle) return { success: false, error: 'Name cannot be empty' };

    const isArchive = !!entry.archived;
    const ext = isArchive ? path.extname(entry.folder) : '';
    const sanitized = sanitizeName(trimmedTitle) || id;
    const parentDir = path.dirname(entry.folder);
    const newPath = path.join(parentDir, sanitized + ext);

    if (newPath !== entry.folder) {
        if (fs.existsSync(newPath)) {
            return { success: false, error: 'Something with that name already exists in the same folder' };
        }
        try {
            fs.renameSync(entry.folder, newPath);
        } catch (e) {
            return { success: false, error: e.message };
        }
        entry.folder = newPath;
    }

    entry.title = trimmedTitle;
    library[id] = entry;
    atomicWriteFileSync(libFile, JSON.stringify(library, null, 2));

    if (listFile) {
        updateListDisplayName(listFile, id, buildDisplayName(trimmedTitle, entry.author));
    }

    return { success: true, folder: entry.folder };
}

// Reads every page image already on disk for a gallery and packs them into a .cbz
// (a plain ZIP under the hood) next to the original folder, then removes the folder.
// Fully synchronous and only ever runs when explicitly triggered (a user click, or right
// after a single gallery finishes downloading) — never as a recurring/background job.
function compressLibraryEntry(id, options = {}, libFile = DEFAULT_LIBRARY_FILE) {
    const ext = options.ext === 'zip' ? 'zip' : 'cbz';
    const library = loadLibrary(libFile);
    const entry = library[id];
    if (!entry || !entry.folder || !fs.existsSync(entry.folder)) {
        return { success: false, error: 'Gallery not found or its folder is missing' };
    }
    if (entry.archived) {
        return { success: false, error: 'Already compressed', skipped: true };
    }

    let files;
    try {
        files = fs.readdirSync(entry.folder, { withFileTypes: true })
            .filter(d => d.isFile() && /^\d+\.(jpg|jpeg|png|webp|gif)$/i.test(d.name))
            .map(d => d.name)
            .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    } catch (e) {
        return { success: false, error: e.message };
    }

    if (files.length === 0) {
        return { success: false, error: 'No page images found in this folder' };
    }

    let zipBuf;
    try {
        const entries = files.map(name => ({ name, data: fs.readFileSync(path.join(entry.folder, name)) }));
        zipBuf = buildZip(entries);
    } catch (e) {
        return { success: false, error: 'Failed to build archive: ' + e.message };
    }

    const parentDir = path.dirname(entry.folder);
    const baseName = sanitizeName(entry.title) || id;
    let cbzPath = path.join(parentDir, `${baseName}.${ext}`);
    let suffix = 2;
    while (fs.existsSync(cbzPath)) {
        cbzPath = path.join(parentDir, `${baseName} (${suffix}).${ext}`);
        suffix++;
    }

    try {
        fs.writeFileSync(cbzPath, zipBuf);
    } catch (e) {
        return { success: false, error: `Failed to write .${ext}: ` + e.message };
    }

    try {
        fs.rmSync(entry.folder, { recursive: true, force: true });
    } catch (e) {
        // Non-fatal: the archive exists and is valid, just couldn't clean up the old folder.
    }

    entry.folder = cbzPath;
    entry.archived = true;
    entry.archiveExt = ext;
    library[id] = entry;
    atomicWriteFileSync(libFile, JSON.stringify(library, null, 2));

    return { success: true, cbzPath, pages: files.length, sizeBytes: zipBuf.length };
}

module.exports = {
    get DEFAULT_LIBRARY_FILE() { return DEFAULT_LIBRARY_FILE; },
    get DEFAULT_ERROR_LOG() { return DEFAULT_ERROR_LOG; },
    setStateDir,
    loadLibrary,
    saveToLibrary,
    saveArchivedToLibrary,
    saveSkippedToLibrary,
    logError,
    syncListTracker,
    updateListStatus,
    isLibraryEntryValid,
    isPermanentlySkipped,
    buildDisplayName,
    getCachedDisplayName,
    updateListDisplayName,
    trackerFileToListPath,
    rescanLibrary,
    renameLibraryEntry,
    compressLibraryEntry,
    getBatchFormatForGallery
};
