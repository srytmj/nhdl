const http = require('http');
const fs = require('fs');
const path = require('path');

const DownloaderEngine = require('../core/engine');
const { DEFAULT_ERROR_LOG, syncListTracker, updateListStatus, loadLibrary, rescanLibrary, renameLibraryEntry, compressLibraryEntry } = require('../core/tracker');
const { extractGalleries } = require('../core/utils');
const { logActivity, readActivityLog, ACTIVITY_LOG } = require('../core/logger');

const ROOT_DIR = path.resolve(__dirname, '..');
const LIST_FILE = path.join(ROOT_DIR, 'list.txt');
const STATUS_FILE = path.join(ROOT_DIR, 'list_status.txt');
const WEBUI_DIST = path.join(ROOT_DIR, 'webui', 'dist');

const PORT = parseInt(process.env.PORT, 10) || 8080;

const engine = new DownloaderEngine();

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

process.on('uncaughtException', (err) => {
    console.error('[!] Uncaught Exception in Server:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[!] Unhandled Rejection in Server:', reason && reason.message ? reason.message : reason);
});

// Batch-compress runs as a plain background job on the server process, independent of any
// HTTP connection. `compressJob` is polled via GET /api/library/compress-status so the UI
// can show live progress, and the job itself is unaffected by the browser tab closing.
let compressJob = null;

function startBatchCompressJob(ids, ext) {
    const library = loadLibrary();
    compressJob = {
        total: ids.length,
        done: 0,
        currentId: null,
        currentTitle: null,
        converted: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        startedAt: new Date().toISOString(),
        finishedAt: null
    };

    (async () => {
        for (const id of ids) {
            const strId = id.toString();
            compressJob.currentId = strId;
            compressJob.currentTitle = (library[strId] && library[strId].title) || strId;

            const result = compressLibraryEntry(strId, { ext });
            if (result.success) compressJob.converted++;
            else if (result.skipped) compressJob.skipped++;
            else { compressJob.failed++; compressJob.errors.push({ id: strId, error: result.error }); }

            compressJob.done++;
            // Yield back to the event loop between files so /api/library/compress-status
            // polls (and the rest of the server) stay responsive during a big batch.
            await new Promise(resolve => setImmediate(resolve));
        }
        compressJob.currentId = null;
        compressJob.currentTitle = null;
        compressJob.finishedAt = new Date().toISOString();
        logActivity(`Batch compress: ${compressJob.converted} converted to .${ext === 'zip' ? 'zip' : 'cbz'}, ${compressJob.skipped} already compressed (skipped), ${compressJob.failed} failed`);
    })();
}

function autoProcessQueue() {
    if (fs.existsSync(LIST_FILE)) {
        const synced = syncListTracker(LIST_FILE);
        if (synced && synced.galleryIds.length > 0 && !engine.isRunning) {
            console.log(`[+] Auto-processing queue: ${synced.galleryIds.length} galleries found.`);
            engine.runBatch(synced.galleryIds, synced.trackerFile);
        }
    }
}

// A "batch" in runBatch() terms is just whatever pendingIds snapshot it started with — it
// doesn't know about newly-added items. When one such run finishes, optionally pick up
// anything new that was queued meanwhile (e.g. a later "Insert Target" paste) instead of
// requiring the user to press START again.
engine.on('batch_complete', () => {
    if (engine.autoContinueBatches) {
        autoProcessQueue();
    }
});

const server = http.createServer((req, res) => {
    // API Endpoints
    if (req.url.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        if (req.method === 'GET' && req.url === '/api/status') {
            let listContent = fs.existsSync(LIST_FILE) ? fs.readFileSync(LIST_FILE, 'utf-8') : '';
            let statusContent = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf-8') : '';
            let errorContent = fs.existsSync(DEFAULT_ERROR_LOG) ? fs.readFileSync(DEFAULT_ERROR_LOG, 'utf-8') : '';

            const statusLines = statusContent.split('\n').filter(l => l.trim());
            // Lines that look like "# BATCH 3" mark where a user's paste/insert began —
            // everything below one, until the next marker, belongs to that batch. Content
            // that predates this feature (no marker at all) is treated as batch 1.
            let currentBatch = 1;
            let batchCount = 1;
            const items = [];
            statusLines.forEach(line => {
                const batchMatch = line.match(/^#\s*BATCH\s+(\d+)/i);
                if (batchMatch) {
                    currentBatch = parseInt(batchMatch[1], 10);
                    batchCount = Math.max(batchCount, currentBatch);
                    return;
                }
                if (line.trim().startsWith('#')) return;

                const match = line.match(/^\[(.*?)\]\s*(.*)$/);
                if (match) {
                    items.push({ status: match[1], url: match[2], batch: currentBatch });
                } else {
                    items.push({ status: 'UNKNOWN', url: line, batch: currentBatch });
                }
            });

            return res.end(JSON.stringify({
                items,
                batchCount,
                rawList: listContent,
                errors: errorContent,
                liveProgress: engine.currentProgress,
                engineStatus: engine.getStatus(),
                autoContinueBatches: engine.autoContinueBatches
            }));
        }

        if (req.method === 'GET' && req.url === '/api/library') {
            const library = loadLibrary();
            const items = Object.entries(library).map(([id, data]) => ({
                id,
                title: data.title || 'Unknown',
                author: data.author || null,
                lang: data.lang || null,
                pages: data.pages || 0,
                folder: data.folder || null,
                downloadedAt: data.downloadedAt || null,
                legacy: !!data.legacy,
                archived: !!data.archived,
                archiveExt: data.archiveExt || null
            })).sort((a, b) => {
                if (!a.downloadedAt) return 1;
                if (!b.downloadedAt) return -1;
                return new Date(b.downloadedAt) - new Date(a.downloadedAt);
            });
            return res.end(JSON.stringify({ items, total: items.length }));
        }

        if (req.method === 'POST' && req.url === '/api/library/rescan') {
            // One-shot, on-demand disk walk — only runs when the user explicitly asks for
            // it (button click), never on a timer/interval, so it doesn't cost any CPU
            // the rest of the time.
            try {
                const result = rescanLibrary(engine.baseDownloadDir);
                logActivity(`Library rescan: ${result.relocated} relocated, ${result.pruned} pruned (no folder found), ${result.unchanged} unchanged`);
                return res.end(JSON.stringify({ success: true, ...result }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        }

        if (req.method === 'POST' && req.url === '/api/queue') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    const { text } = JSON.parse(body);
                    if (typeof text === 'string') {
                        fs.writeFileSync(LIST_FILE, text, 'utf-8');
                        const synced = syncListTracker(LIST_FILE);
                        logActivity(`Queue saved: ${synced ? synced.galleryIds.length : 0} gallery line(s) in list.txt`);
                        res.end(JSON.stringify({ success: true }));

                        if (synced && synced.galleryIds.length > 0 && !engine.isRunning && !engine.isPaused) {
                            engine.runBatch(synced.galleryIds, synced.trackerFile);
                        }
                    } else {
                        res.writeHead(400);
                        res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
                    }
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/control') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    let action = '';
                    try {
                        const parsed = JSON.parse(body);
                        action = parsed.action;
                    } catch(pe) {
                        try {
                            const unescaped = body.replace(/\\"/g, '"');
                            const parsed = JSON.parse(unescaped);
                            action = parsed.action;
                        } catch(pe2) {
                            if (body.includes('pause')) action = 'pause';
                            else if (body.includes('resume')) action = 'resume';
                            else if (body.includes('restart')) action = 'restart';
                            else if (body.includes('start')) action = 'start';
                        }
                    }

                    logActivity(`Control action: ${action || '(unrecognized)'}`);
                    if (action === 'pause' || action === 'stop') {
                        engine.pause();
                    } else if (action === 'resume' || action === 'start') {
                        engine.resume();
                        autoProcessQueue();
                    } else if (action === 'restart') {
                        if (fs.existsSync(LIST_FILE)) {
                            const synced = syncListTracker(LIST_FILE);
                            if (synced && synced.galleryIds.length > 0) {
                                engine.restart(synced.galleryIds, synced.trackerFile);
                            }
                        }
                    }
                    return res.end(JSON.stringify({ success: true, engineStatus: engine.getStatus() }));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/api/config') {
            return res.end(JSON.stringify({
                downloadDir: engine.baseDownloadDir,
                downloadFormat: engine.downloadFormat,
                autoContinueBatches: engine.autoContinueBatches
            }));
        }

        if (req.method === 'POST' && req.url === '/api/config') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    const { downloadDir, downloadFormat, autoContinueBatches } = JSON.parse(body);
                    if (typeof autoContinueBatches === 'boolean') {
                        engine.setAutoContinueBatches(autoContinueBatches);
                        return res.end(JSON.stringify({ success: true, autoContinueBatches: engine.autoContinueBatches }));
                    }
                    if (downloadFormat) {
                        engine.setDownloadFormat(downloadFormat);
                        return res.end(JSON.stringify({ success: true, downloadFormat: engine.downloadFormat }));
                    }
                    if (downloadDir && typeof downloadDir === 'string') {
                        if (!fs.existsSync(downloadDir)) {
                            fs.mkdirSync(downloadDir, { recursive: true });
                        }
                        engine.setDownloadDir(downloadDir);
                        return res.end(JSON.stringify({ success: true, downloadDir: engine.baseDownloadDir }));
                    }
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/library/rename') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    const { id, newName } = JSON.parse(body);
                    if (!id || !newName) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ success: false, error: 'id and newName are required' }));
                    }
                    const result = renameLibraryEntry(id.toString(), newName, undefined, LIST_FILE);
                    if (result.success) logActivity(`Renamed ID ${id} -> "${newName}"`);
                    if (!result.success) res.writeHead(400);
                    return res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/library/compress') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    const { id, ext } = JSON.parse(body);
                    if (!id) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ success: false, error: 'id is required' }));
                    }
                    const result = compressLibraryEntry(id.toString(), { ext });
                    if (result.success) logActivity(`Compressed ID ${id} to .${ext === 'zip' ? 'zip' : 'cbz'}`);
                    if (!result.success) res.writeHead(400);
                    return res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/api/library/batch-compress') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    const { ids, ext } = JSON.parse(body);
                    if (!Array.isArray(ids) || ids.length === 0) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ success: false, error: 'ids array is required' }));
                    }
                    if (compressJob && !compressJob.finishedAt) {
                        res.writeHead(409);
                        return res.end(JSON.stringify({ success: false, error: 'A batch compress is already running' }));
                    }
                    // Runs detached from this request/response — it's a plain async loop on
                    // the Node process, so closing the browser tab (which only drops the HTTP
                    // connection) has no effect on it. Progress is polled separately via
                    // /api/library/compress-status, which works even after reopening the app.
                    startBatchCompressJob(ids, ext);
                    return res.end(JSON.stringify({ success: true, started: true, total: ids.length }));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/api/library/compress-status') {
            return res.end(JSON.stringify({ job: compressJob }));
        }

        if (req.method === 'GET' && req.url === '/api/logs') {
            return res.end(JSON.stringify({ log: readActivityLog() }));
        }

        if (req.method === 'GET' && req.url === '/api/logs/download') {
            const log = readActivityLog();
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="nhdl-activity-${Date.now()}.log"`);
            return res.end(log);
        }

        if (req.method === 'POST' && req.url === '/api/retry') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    let payload = {};
                    if (body && body.trim()) {
                        try { payload = JSON.parse(body); } catch(e) {}
                    }
                    const { galleryId } = payload;
                    engine.triggerForceRetry();

                    if (galleryId) {
                        updateListStatus(STATUS_FILE, galleryId, 'PENDING');
                        autoProcessQueue();
                    }
                    return res.end(JSON.stringify({ success: true, message: 'Force retry triggered' }));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
            return;
        }

        if (req.method === 'GET' && req.url.startsWith('/api/fs/browse')) {
            const urlObj = new URL(req.url, 'http://localhost');
            let targetPath = urlObj.searchParams.get('path');

            const isWindows = process.platform === 'win32';
            let availableDrives = [];
            if (isWindows) {
                const possibleDrives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
                availableDrives = possibleDrives.filter(d => {
                    try { return fs.existsSync(d + ':\\'); } catch(e) { return false; }
                }).map(d => d + ':\\');
            }

            if (!targetPath || targetPath.trim() === '') {
                targetPath = engine.baseDownloadDir;
            }

            targetPath = path.resolve(targetPath);

            try {
                if (!fs.existsSync(targetPath)) {
                    return res.end(JSON.stringify({
                        currentPath: targetPath,
                        parentPath: path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath),
                        drives: availableDrives,
                        directories: []
                    }));
                }

                const dirents = fs.readdirSync(targetPath, { withFileTypes: true });
                const directories = [];

                for (const dirent of dirents) {
                    try {
                        if (dirent.isDirectory()) {
                            if (!dirent.name.startsWith('$') && !dirent.name.startsWith('.')) {
                                directories.push({
                                    name: dirent.name,
                                    path: path.join(targetPath, dirent.name)
                                });
                            }
                        }
                    } catch (e) {}
                }

                directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
                const parentPath = path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath);

                return res.end(JSON.stringify({
                    currentPath: targetPath,
                    parentPath,
                    drives: availableDrives,
                    directories
                }));
            } catch (err) {
                return res.end(JSON.stringify({
                    currentPath: targetPath,
                    parentPath: path.dirname(targetPath) === targetPath ? null : path.dirname(targetPath),
                    drives: availableDrives,
                    directories: [],
                    error: err.message
                }));
            }
        }

        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
    }

    // Static Asset Serving from webui/dist
    let safePath = req.url === '/' ? '/index.html' : req.url;
    safePath = path.normalize(safePath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(WEBUI_DIST, safePath);

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                const indexPath = path.join(WEBUI_DIST, 'index.html');
                fs.readFile(indexPath, (err2, content2) => {
                    if (err2) {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('Web UI dist not found. Run npm run build inside webui folder.');
                    } else {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(content2, 'utf-8');
                    }
                });
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Internal Server Error: ${err.code}`);
            }
        } else {
            const extname = String(path.extname(filePath)).toLowerCase();
            const contentType = mimeTypes[extname] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\x1b[32m[+] NHDL Web Daemon aktif pada http://0.0.0.0:${PORT}\x1b[0m`);
    console.log(`[+] Web UI Dashboard: http://localhost:${PORT}`);

    // One-shot startup scan only (not a recurring interval) to pick up any folders that
    // were moved while the server was down. Never runs again on its own after this.
    try {
        const result = rescanLibrary(engine.baseDownloadDir);
        if (result.relocated > 0 || result.pruned > 0) {
            console.log(`[+] Library rescan: relocated ${result.relocated}, pruned ${result.pruned} (no folder on disk).`);
        }
        logActivity(`Startup rescan: ${result.relocated} relocated, ${result.pruned} pruned, ${result.unchanged} unchanged`);
    } catch (e) {}

    autoProcessQueue();
});
