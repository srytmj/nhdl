const EventEmitter = require('events');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const { sanitizeName, toTitleCase, getDynamicDelay, verifyImage, sleep, withFsRetryAsync, atomicWriteFileSync } = require('./utils');
const { loadLibrary, saveToLibrary, saveArchivedToLibrary, saveSkippedToLibrary, logError, updateListStatus, isLibraryEntryValid, isPermanentlySkipped, buildDisplayName, getCachedDisplayName, updateListDisplayName, trackerFileToListPath, compressLibraryEntry, getBatchFormatForGallery, setStateDir } = require('./tracker');
const { logActivity, setLogDir } = require('./logger');

dns.setServers(['1.1.1.1', '8.8.8.8']);
const NHENTAI_MAIN_IP = '104.26.4.188';

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// On Windows, cmd.exe resolves "curl" to the bundled system32 curl.exe (Schannel build),
// whose TLS fingerprint gets flagged by Cloudflare as a bot and triggers false 429s.
// Prefer Git's mingw64 curl build, which is not flagged, when it's available.
function resolveCurlBinary() {
    if (process.platform !== 'win32') return 'curl';
    const candidates = [
        'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe',
        'C:\\Program Files\\Git\\usr\\bin\\curl.exe'
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return `"${candidate}"`;
    }
    return 'curl';
}
const CURL_BIN = resolveCurlBinary();

class DownloaderEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        let savedDownloadDir = null;
        let savedDownloadFormat = 'folder';
        let savedAutoContinue = true;
        if (fs.existsSync(CONFIG_FILE)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
                if (cfg.downloadDir) savedDownloadDir = cfg.downloadDir;
                if (cfg.downloadFormat === 'cbz') savedDownloadFormat = 'cbz';
                if (cfg.autoContinueBatches === false) savedAutoContinue = false;
            } catch (e) {}
        }

        this.baseDownloadDir = options.baseDownloadDir || process.env.DOWNLOAD_DIR || savedDownloadDir || path.join(__dirname, '..', 'Download');
        // Queue/library/log state lives next to the downloads themselves (a persistent
        // volume) instead of the app dir (container's writable layer, wiped on rebuild).
        if (!fs.existsSync(this.baseDownloadDir)) fs.mkdirSync(this.baseDownloadDir, { recursive: true });
        setStateDir(this.baseDownloadDir);
        setLogDir(this.baseDownloadDir);
        this.downloadFormat = options.downloadFormat || savedDownloadFormat;
        this.autoContinueBatches = options.autoContinueBatches !== undefined ? options.autoContinueBatches : savedAutoContinue;
        this.batchSize = options.batchSize || 50;
        this.batchRestMinutes = options.batchRestMinutes || 5;
        this.concurrency = options.concurrency || 3;
        this.isRunning = false;
        this.isStopped = false;
        this.isPaused = false;
        this.forceRetry = false;
        this.currentProgress = null;

        // Anti-rate-limit state: every consecutive 429 makes the engine more cautious
        // (longer waits, slower pacing). Any fully successful real download resets this
        // back to normal speed. See the RATE_LIMIT handling in runBatch().
        this.consecutiveRateLimits = 0;
        this.circuitBreakerTripped = false;
    }

    pause() {
        this.isPaused = true;
        this.emit('paused');
    }

    resume() {
        this.isPaused = false;
        // A manual resume is a deliberate human decision that enough time has passed —
        // give it a clean slate instead of immediately re-tripping on the old count.
        this.consecutiveRateLimits = 0;
        this.circuitBreakerTripped = false;
        this.emit('resumed');
    }

    getStatus() {
        if (this.isPaused) return 'PAUSED';
        if (!this.isRunning) return 'IDLE';
        if (this.currentProgress) {
            if (this.currentProgress.type === 'RATE_LIMIT') return 'COOLDOWN_429';
            if (this.currentProgress.type === 'COOLDOWN' || this.currentProgress.type === 'BATCH_REST') return 'COOLDOWN';
        }
        return 'RUNNING';
    }

    setDownloadDir(newDir) {
        if (!newDir || typeof newDir !== 'string') return;
        this.baseDownloadDir = path.resolve(newDir);
        if (!fs.existsSync(this.baseDownloadDir)) fs.mkdirSync(this.baseDownloadDir, { recursive: true });
        setStateDir(this.baseDownloadDir);
        setLogDir(this.baseDownloadDir);
        try {
            let cfg = {};
            if (fs.existsSync(CONFIG_FILE)) {
                try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
            }
            cfg.downloadDir = this.baseDownloadDir;
            atomicWriteFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
            this.emit('config_updated', { downloadDir: this.baseDownloadDir });
        } catch (e) {
            console.error("Failed to save config.json:", e.message);
        }
    }

    setDownloadFormat(format) {
        if (format !== 'folder' && format !== 'cbz') return;
        this.downloadFormat = format;
        try {
            let cfg = {};
            if (fs.existsSync(CONFIG_FILE)) {
                try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
            }
            cfg.downloadFormat = format;
            atomicWriteFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
            this.emit('config_updated', { downloadFormat: format });
        } catch (e) {
            console.error("Failed to save config.json:", e.message);
        }
    }

    setAutoContinueBatches(enabled) {
        this.autoContinueBatches = !!enabled;
        try {
            let cfg = {};
            if (fs.existsSync(CONFIG_FILE)) {
                try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
            }
            cfg.autoContinueBatches = this.autoContinueBatches;
            atomicWriteFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
            this.emit('config_updated', { autoContinueBatches: this.autoContinueBatches });
        } catch (e) {
            console.error("Failed to save config.json:", e.message);
        }
    }

    triggerForceRetry() {
        this.forceRetry = true;
        this.emit('retry_triggered');
    }

    // Decides whether a just-completed gallery should be compressed, using whichever
    // format its own batch was tagged with (the Insert Target dropdown), falling back to
    // this.downloadFormat only when there's no per-batch tag (e.g. CLI usage without a
    // trackerFile, or a batch predating this feature).
    maybeCompress(galleryId, trackerFile) {
        const format = trackerFile
            ? getBatchFormatForGallery(trackerFileToListPath(trackerFile), galleryId)
            : this.downloadFormat;
        if (format === 'cbz' || format === 'zip') {
            const result = compressLibraryEntry(galleryId, { ext: format });
            if (result.success) logActivity(`Compressed ID ${galleryId} to .${format}`);
        }
    }

    getRandomImageHost() {
        const serverNum = Math.floor(Math.random() * 4) + 1; // i1 - i4
        return `i${serverNum}.nhentai.net`;
    }

    async resolveDomain(domain) {
        if (domain.includes('nhentai.net')) {
            return NHENTAI_MAIN_IP;
        }
        return new Promise((resolve) => {
            dns.resolve4(domain, (err, addresses) => {
                if (err || !addresses || addresses.length === 0) return resolve(NHENTAI_MAIN_IP);
                if (addresses[0].startsWith('202.169.') || addresses[0].startsWith('36.') || addresses[0].startsWith('103.')) {
                    return resolve(NHENTAI_MAIN_IP);
                }
                resolve(addresses[0]);
            });
        });
    }

    httpsGet(url, hostHeader, targetIp) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const options = {
                hostname: targetIp,
                port: 443,
                path: urlObj.pathname + urlObj.search,
                headers: {
                    'Host': hostHeader,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://nhentai.net/'
                },
                servername: hostHeader
            };

            const req = https.get(options, (res) => {
                if (res.statusCode !== 200) return reject(new Error(`Status Code: ${res.statusCode}`));
                resolve(res);
            });

            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Socket Timeout'));
            });

            req.on('error', reject);
        });
    }

    downloadImage(url, destPath, hostHeader, onProgress) {
        return new Promise(async (resolve, reject) => {
            let hardTimeout;
            try {
                const targetIp = await this.resolveDomain(hostHeader);
                hardTimeout = setTimeout(() => {
                    reject(new Error("Hard Timeout (Stalled)"));
                }, 30000);

                const res = await this.httpsGet(url, hostHeader, targetIp);
                const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                let received = 0;
                if (onProgress) onProgress(0, totalBytes);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (onProgress) onProgress(received, totalBytes);
                });

                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    clearTimeout(hardTimeout);
                    fileStream.close(resolve);
                });

                fileStream.on('error', (err) => {
                    clearTimeout(hardTimeout);
                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                    reject(err);
                });
            } catch (err) {
                clearTimeout(hardTimeout);
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                reject(err);
            }
        });
    }

    // Searches the whole download tree for a folder or archive matching a (possibly stale)
    // cached title, without needing a language/author breakdown from fresh metadata. Used
    // only as a 429 fallback — see the RATE_LIMIT branch in processGallery().
    findExistingOnDisk(cachedTitle, cachedAuthor) {
        const sanitizedTitle = sanitizeName(cachedTitle);
        if (!sanitizedTitle) return null;
        const sanitizedAuthor = cachedAuthor ? sanitizeName(cachedAuthor) : null;

        let langDirs;
        try {
            langDirs = fs.readdirSync(this.baseDownloadDir, { withFileTypes: true }).filter(d => d.isDirectory());
        } catch (e) { return null; }

        for (const langDir of langDirs) {
            let authorDirs;
            const langPath = path.join(this.baseDownloadDir, langDir.name);
            try {
                authorDirs = fs.readdirSync(langPath, { withFileTypes: true }).filter(d => d.isDirectory());
            } catch (e) { continue; }

            for (const authorDir of authorDirs) {
                if (sanitizedAuthor && authorDir.name !== sanitizedAuthor) continue;
                const parentDir = path.join(langPath, authorDir.name);
                let siblings;
                try {
                    siblings = fs.readdirSync(parentDir, { withFileTypes: true });
                } catch (e) { continue; }

                const archiveMatch = siblings.find(d => {
                    if (!d.isFile()) return false;
                    const m = d.name.match(/^(.*)\.(cbz|zip)$/i);
                    return m && m[1].startsWith(sanitizedTitle);
                });
                if (archiveMatch) {
                    const archiveExt = archiveMatch.name.match(/\.(cbz|zip)$/i)[1].toLowerCase();
                    return { archived: true, path: path.join(parentDir, archiveMatch.name), title: cachedTitle, archiveExt, pages: 0 };
                }

                const folderMatch = siblings.find(d => d.isDirectory() && d.name.startsWith(sanitizedTitle));
                if (folderMatch) {
                    const folderPath = path.join(parentDir, folderMatch.name);
                    let files;
                    try {
                        files = fs.readdirSync(folderPath).filter(f => /^\d+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
                    } catch (e) { files = []; }
                    if (files.length === 0) continue;
                    const pageExts = {};
                    let maxPage = 0;
                    let ext = 'jpg';
                    for (const f of files) {
                        const m = f.match(/^(\d+)\.(\w+)$/);
                        if (m) {
                            const p = parseInt(m[1], 10);
                            pageExts[p] = m[2];
                            ext = m[2];
                            if (p > maxPage) maxPage = p;
                        }
                    }
                    return { archived: false, path: folderPath, title: cachedTitle, pages: maxPage, ext, pageExts };
                }
            }
        }
        return null;
    }

    async fetchMetadata(galleryId) {
        const curlCmd = `${CURL_BIN} -skL --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" https://nhentai.net/g/${galleryId}/`;
        let html = '';
        try {
            const { stdout } = await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true });
            html = stdout;
        } catch (e) {
            try {
                const fallbackCmd = `curl -skL --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" https://nhentai.net/g/${galleryId}/`;
                const { stdout } = await execAsync(fallbackCmd, { encoding: 'utf-8', windowsHide: true });
                html = stdout;
            } catch (e2) {
                html = e2.stdout || '';
            }
        }

        let title = "Unknown_Title";
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        const metaTitleMatch = html.match(/<meta itemprop="name" content="([^"]+)"/);

        // Note: "challenge-platform" alone is NOT a reliable signal — Cloudflare injects that
        // script tag on normal, successful pages too. Only the title/explicit-block-text checks
        // reliably indicate an actual 429/JS-challenge block.
        if (titleMatch && (titleMatch[1].includes("Error 429") || titleMatch[1].includes("Just a moment...")) ||
            html.includes("Rate limit exceeded") || html.includes("Attention Required! | Cloudflare")) {
            return { status: "RATE_LIMIT" };
        } else if (titleMatch && titleMatch[1].includes("404")) {
            const e = new Error("Link tidak dapat diakses (404 - gallery not found / sudah dihapus)");
            e.permanent = true;
            throw e;
        } else if (!html || html.trim().length === 0) {
            throw new Error("Empty response (network issue, not a broken link)");
        }

        if (metaTitleMatch) title = metaTitleMatch[1];

        let mediaId = null;
        const mediaMatch = html.match(/\\?"media_id\\?":\s*\\?"(\d+)\\?"/);
        if (mediaMatch) mediaId = mediaMatch[1];
        else throw new Error("Failed to find media_id (HTML blocked by Cloudflare)");

        let numPages = 0;
        const numMatch = html.match(/\\?"num_pages\\?":\s*(\d+)/);
        if (numMatch) numPages = parseInt(numMatch[1], 10);
        else throw new Error("Failed to find total page count");

        let ext = "jpg";
        const extMatch = html.match(/\\?"path\\?":\\?"galleries\/\d+\/1\.(jpg|png|webp|gif)\\?"/);
        if (extMatch) ext = extMatch[1];

        // nhentai galleries can mix file extensions across pages (e.g. page 1 is .webp but
        // page 2 is .jpg) — relying on a single gallery-wide ext causes those pages to 404
        // forever. Build a per-page extension map from the full pages array as the source of truth.
        const pageExts = {};
        const pageMatches = html.matchAll(/\\?"number\\?":(\d+),\\?"path\\?":\\?"galleries\/\d+\/\d+\.(jpg|png|webp|gif)\\?"/g);
        for (const m of pageMatches) {
            pageExts[parseInt(m[1], 10)] = m[2];
        }

        const langMatches = [...html.matchAll(/\\"type\\":\\"language\\",\\"name\\":\\"([^\\"]+)\\"/g)].map(m => m[1]);
        let langStr = "Unknown";
        if (langMatches.length > 0) langStr = toTitleCase(langMatches[langMatches.length - 1]);

        const artistMatches = [...html.matchAll(/\\"type\\":\\"artist\\",\\"name\\":\\"([^\\"]+)\\"/g)].map(m => m[1]);
        const groupMatches = [...html.matchAll(/\\"type\\":\\"group\\",\\"name\\":\\"([^\\"]+)\\"/g)].map(m => m[1]);
        let authorStr = "Other";
        if (artistMatches.length > 0) authorStr = toTitleCase(artistMatches[0]);
        else if (groupMatches.length > 0) authorStr = toTitleCase(groupMatches[0]);

        return {
            title,
            mediaId,
            numPages,
            ext,
            pageExts,
            langStr,
            authorStr
        };
    }

    async processGallery(galleryId, currentTaskNum = 1, totalTasks = 1, trackerFile = null) {
        if (trackerFile) updateListStatus(trackerFile, galleryId, "ON_PROGRESS");

        const library = loadLibrary();
        if (library[galleryId] && library[galleryId].folder && fs.existsSync(library[galleryId].folder) && library[galleryId].pages && library[galleryId].ext) {
            const data = library[galleryId];
            // Archived (.cbz) entries aren't a folder of loose pages anymore — the zip
            // existing on disk (already checked above) is proof enough it's complete.
            let allValid = !!data.archived;
            if (!allValid) {
                const savedPageExts = data.pageExts || {};
                allValid = true;
                for (let j = 1; j <= data.pages; j++) {
                    if (!verifyImage(path.join(data.folder, `${j}.${savedPageExts[j] || data.ext}`))) {
                        allValid = false;
                        break;
                    }
                }
            }
            if (allValid) {
                if (trackerFile) {
                    updateListStatus(trackerFile, galleryId, "SKIPPED - Already in Library");
                    // Reuses metadata already stored from when this gallery was originally
                    // downloaded — no extra network request needed to show the full name.
                    updateListDisplayName(trackerFileToListPath(trackerFile), galleryId, buildDisplayName(data.title, data.author));
                }
                this.emit('skipped', { galleryId, title: data.title, currentTaskNum, totalTasks, reason: 'Already in Library' });
                // Pure library.json lookup — zero network requests made, nothing to pace.
                return { status: "SUCCESS", numPages: data.pages, skipped: true, skipReason: 'library' };
            }
        }

        const meta = await this.fetchMetadata(galleryId);
        if (meta.status === "RATE_LIMIT") {
            // Before committing to a 5-minute cooldown: if a previous run already got far
            // enough to write this gallery's title into list.txt, use that cached name to
            // check disk directly — no network needed for that. Covers exactly the case
            // where library.json lost track of an already-finished download (e.g. the
            // corruption incident) and a 429 on the metadata re-fetch would otherwise block
            // ever discovering the file is already there.
            const cached = trackerFile ? getCachedDisplayName(trackerFileToListPath(trackerFile), galleryId) : null;
            if (cached && cached.title) {
                const found = this.findExistingOnDisk(cached.title, cached.author);
                if (found) {
                    if (found.archived) {
                        saveArchivedToLibrary(galleryId, found.title, found.path, found.archiveExt, { author: cached.author });
                    } else {
                        saveToLibrary(galleryId, found.title, found.path, found.pages, found.ext, found.pageExts, { author: cached.author });
                    }
                    if (trackerFile) {
                        updateListStatus(trackerFile, galleryId, "SKIPPED - Found on disk (metadata was 429'd)");
                    }
                    logActivity(`SKIPPED ID ${galleryId}: found existing file on disk, avoided 429 cooldown`);
                    this.emit('skipped', { galleryId, title: found.title, currentTaskNum, totalTasks, reason: 'Already on disk (metadata blocked by 429)' });
                    // The metadata request itself already got a 429 (blocked, no data) — no
                    // successful request was made here, so there's nothing extra to pace.
                    return { status: "SUCCESS", numPages: found.pages || 0, skipped: true, skipReason: 'library' };
                }
            }
            logError(galleryId, "Cloudflare Rate Limit / Challenge (429)");
            if (trackerFile) updateListStatus(trackerFile, galleryId, "COOLDOWN - CLOUDFLARE 429");
            return { status: "RATE_LIMIT" };
        }

        const { title, mediaId, numPages, ext, pageExts, langStr, authorStr } = meta;
        const extFor = (page) => pageExts[page] || ext;
        const sanitizedLang = sanitizeName(langStr);
        const sanitizedAuthor = sanitizeName(authorStr);
        const sanitizedTitle = sanitizeName(title) || galleryId;

        if (trackerFile) {
            // Same metadata call already needed for the download itself — reusing it to fill
            // in the full title + artist/group in list.txt costs zero extra requests.
            updateListDisplayName(trackerFileToListPath(trackerFile), galleryId, buildDisplayName(title, authorStr));
        }

        const parentDir = path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor);
        let folderPath = path.join(parentDir, sanitizedTitle);

        // Not in library.json doesn't mean not downloaded — it may predate the marker/library
        // feature, or the title got truncated differently than last time (folder-name length
        // limit, a tweak on nhentai's side, etc). Before creating a fresh folder (and before
        // downloading a single byte), check what's already sitting in the parent dir.
        if (fs.existsSync(parentDir)) {
            try {
                const siblings = fs.readdirSync(parentDir, { withFileTypes: true });

                // Already compressed to .cbz/.zip under this title (exact or untruncated)?
                // That archive file IS the finished download — adopt it into library.json
                // and stop here, no folder, no page requests, no re-download.
                const archiveMatch = siblings.find(d => {
                    if (!d.isFile()) return false;
                    const m = d.name.match(/^(.*)\.(cbz|zip)$/i);
                    return m && m[1].startsWith(sanitizedTitle);
                });
                if (archiveMatch) {
                    const archiveExt = archiveMatch.name.match(/\.(cbz|zip)$/i)[1].toLowerCase();
                    const archivePath = path.join(parentDir, archiveMatch.name);
                    saveArchivedToLibrary(galleryId, sanitizedTitle, archivePath, archiveExt, { author: authorStr, lang: langStr, pages: numPages });
                    if (trackerFile) {
                        updateListStatus(trackerFile, galleryId, "SKIPPED - Already in Library");
                        updateListDisplayName(trackerFileToListPath(trackerFile), galleryId, buildDisplayName(title, authorStr));
                    }
                    this.emit('skipped', { galleryId, title, currentTaskNum, totalTasks, reason: 'Already Downloaded (Archive)' });
                    // A real metadata request to nhentai just happened (that's how we got
                    // `title` to match against) — pace this like a real hit, not a free skip.
                    return { status: "SUCCESS", numPages, skipped: true, skipReason: 'disk_after_metadata' };
                }

                // Otherwise, an existing folder with this same title (exact, or the on-disk
                // name simply being a longer/untruncated version of it) — resume into it
                // instead of re-downloading everything into a duplicate.
                const folderMatch = siblings.find(d => d.isDirectory() && d.name.startsWith(sanitizedTitle));
                if (folderMatch) folderPath = path.join(parentDir, folderMatch.name);
            } catch (e) {}
        }
        if (!fs.existsSync(folderPath)) {
            try {
                await withFsRetryAsync(() => fs.mkdirSync(folderPath, { recursive: true }), {
                    onRetry: (e, attempt, max) => {
                        logActivity(`WARN ID ${galleryId}: mkdir failed (${e.code}), retry ${attempt}/${max} - ${folderPath}`);
                    }
                });
            } catch (e) {
                if (e.code === 'ENOENT' || e.code === 'ENAMETOOLONG' || e.code === 'EINVAL') {
                    // The sanitized title still produced a path the OS rejects (odd unicode,
                    // length, etc) — fall back to the gallery ID as the folder name instead of
                    // killing the whole batch over one title.
                    folderPath = path.join(parentDir, galleryId.toString());
                    logError(galleryId, `Folder name rejected by filesystem (${e.code}), falling back to gallery ID as folder name`);
                    fs.mkdirSync(folderPath, { recursive: true });
                } else {
                    throw e;
                }
            }
        }

        let completed = 0;
        let pendingPages = [];

        for (let j = 1; j <= numPages; j++) {
            const checkPath = path.join(folderPath, `${j}.${extFor(j)}`);
            if (verifyImage(checkPath)) {
                completed++;
            } else {
                if (fs.existsSync(checkPath)) fs.unlinkSync(checkPath);
                pendingPages.push(j);
            }
        }

        if (completed === numPages) {
            saveToLibrary(galleryId, sanitizedTitle, folderPath, numPages, ext, pageExts, { author: authorStr, lang: langStr });
            this.maybeCompress(galleryId, trackerFile);
            if (trackerFile) updateListStatus(trackerFile, galleryId, "SKIPPED - Files Complete");
            this.emit('skipped', { galleryId, title, currentTaskNum, totalTasks, reason: 'Files 100% Complete' });
            // Same as above — a real metadata request already happened this call.
            return { status: "SUCCESS", numPages, skipped: true, skipReason: 'disk_after_metadata' };
        }

        await new Promise((resolve) => {
            let active = 0;
            const pageRetryCounts = new Map();
            const pageErrors = new Map();
            const activePages = new Map();
            let completedBytes = 0;
            let lastSpeedSample = { at: Date.now(), bytes: 0 };
            let lastByteAt = Date.now();

            const buildProgress = () => {
                const percent = Math.round((completed / numPages) * 100);
                const pagesSnapshot = [...activePages.values()].map(p => ({
                    page: p.page,
                    url: p.url,
                    bytesReceived: p.bytesReceived,
                    totalBytes: p.totalBytes,
                    percent: p.totalBytes > 0 ? Math.round((p.bytesReceived / p.totalBytes) * 100) : 0,
                    attempt: p.attempt,
                    lastError: p.lastError || null
                }));

                const nowBytes = completedBytes + [...activePages.values()].reduce((sum, p) => sum + p.bytesReceived, 0);
                const elapsedSec = Math.max((Date.now() - lastSpeedSample.at) / 1000, 0.001);
                const speedKBps = Math.max(0, Math.round(((nowBytes - lastSpeedSample.bytes) / 1024) / elapsedSec));
                lastSpeedSample = { at: Date.now(), bytes: nowBytes };

                const stalledSeconds = Math.round((Date.now() - lastByteAt) / 1000);
                const stalled = active > 0 && stalledSeconds >= 8;

                return {
                    galleryId,
                    title: title.substring(0, 40),
                    percent,
                    completed,
                    total: numPages,
                    taskNum: currentTaskNum,
                    totalTasks,
                    activePages: pagesSnapshot,
                    speedKBps,
                    stalled,
                    stalledSeconds: stalled ? stalledSeconds : 0,
                    live: true
                };
            };

            const heartbeat = setInterval(() => {
                if (active === 0) return;
                this.currentProgress = buildProgress();
                this.emit('progress', this.currentProgress);
            }, 1000);

            const next = () => {
                if (this.isStopped) {
                    clearInterval(heartbeat);
                    return resolve();
                }
                if (this.isPaused) {
                    setTimeout(next, 500);
                    return;
                }
                if (pendingPages.length === 0 && active === 0) {
                    clearInterval(heartbeat);
                    saveToLibrary(galleryId, sanitizedTitle, folderPath, numPages, ext, pageExts, { author: authorStr, lang: langStr });
                    this.maybeCompress(galleryId, trackerFile);
                    if (trackerFile) updateListStatus(trackerFile, galleryId, "DONE");
                    logActivity(`DONE ID ${galleryId}: "${title}" (${numPages} pages)`);
                    this.currentProgress = null;
                    this.emit('done', { galleryId, title, pages: numPages, currentTaskNum, totalTasks });
                    return resolve();
                }

                while (active < this.concurrency && pendingPages.length > 0 && !this.isStopped) {
                    const currentPage = pendingPages.shift();
                    const pageExt = extFor(currentPage);
                    const destPath = path.join(folderPath, `${currentPage}.${pageExt}`);
                    const dynamicHost = this.getRandomImageHost();
                    const imageUrl = `https://${dynamicHost}/galleries/${mediaId}/${currentPage}.${pageExt}`;
                    const retryCount = pageRetryCounts.get(currentPage) || 0;
                    const startDelay = retryCount > 0 ? Math.min(1000 * 2 ** retryCount, 15000) : Math.floor(Math.random() * 400);

                    const pageEntry = {
                        page: currentPage,
                        url: imageUrl,
                        bytesReceived: 0,
                        totalBytes: 0,
                        attempt: retryCount + 1,
                        lastError: pageErrors.get(currentPage) || null
                    };
                    activePages.set(currentPage, pageEntry);

                    active++;
                    sleep(startDelay)
                        .then(() => this.downloadImage(imageUrl, destPath, dynamicHost, (received, total) => {
                            pageEntry.bytesReceived = received;
                            pageEntry.totalBytes = total;
                            lastByteAt = Date.now();
                        }))
                        .then(() => {
                            if (!verifyImage(destPath)) {
                                pageRetryCounts.set(currentPage, retryCount + 1);
                                pageErrors.set(currentPage, 'Downloaded file failed verification (corrupt/too small)');
                                pendingPages.unshift(currentPage);
                            } else {
                                pageRetryCounts.delete(currentPage);
                                pageErrors.delete(currentPage);
                                completedBytes += pageEntry.bytesReceived;
                                completed++;
                                const percent = Math.round((completed / numPages) * 100);
                                this.currentProgress = buildProgress();
                                this.currentProgress.percent = percent;
                                this.emit('progress', this.currentProgress);
                            }
                        })
                        .catch((err) => {
                            const attempt = retryCount + 1;
                            pageRetryCounts.set(currentPage, attempt);
                            pageErrors.set(currentPage, err.message);
                            pendingPages.unshift(currentPage);

                            // Only log to file once the same page keeps failing, to avoid spamming
                            // error.log on the first transient blip.
                            if (attempt === 3 || attempt % 5 === 0) {
                                logError(galleryId, `Page ${currentPage} (${imageUrl}) failed ${attempt}x: ${err.message}`);
                            }
                        })
                        .finally(() => {
                            activePages.delete(currentPage);
                            active--;
                            next();
                        });
                }
            };
            next();
        });

        return { status: "SUCCESS", numPages, skipped: false };
    }

    async runBatch(galleryIds, trackerFile = null) {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isStopped = false;

        const library = loadLibrary();
        const uniqueIds = [...new Set(galleryIds)];
        const pendingIds = uniqueIds.filter(id => !isLibraryEntryValid(library[id]) && !isPermanentlySkipped(library[id]));

        this.emit('batch_start', { total: uniqueIds.length, pending: pendingIds.length, skipped: uniqueIds.length - pendingIds.length });
        logActivity(`Run started: ${pendingIds.length} pending / ${uniqueIds.length} total (${uniqueIds.length - pendingIds.length} already in library)`);

        if (pendingIds.length === 0) {
            this.isRunning = false;
            this.emit('batch_complete', { processed: 0 });
            return;
        }

        // Startup jitter: every container restart used to start hammering nhentai
        // immediately, and several restarts close together (exactly what happened during
        // today's incident/debugging) sent bursts of near-simultaneous requests that look
        // bot-like to Cloudflare. A small random pause before the very first request breaks
        // up that pattern for free.
        const startupJitterMs = 5000 + Math.floor(Math.random() * 10000);
        logActivity(`Run starting in ${Math.round(startupJitterMs / 1000)}s (startup jitter, anti-burst)`);
        await sleep(startupJitterMs);

        for (let i = 0; i < pendingIds.length; i++) {
            if (this.isStopped) break;
            while (this.isPaused && !this.isStopped) {
                await sleep(500);
            }
            if (this.isStopped) break;
            const id = pendingIds[i];

            let result = null;
            try {
                result = await this.processGallery(id, i + 1, pendingIds.length, trackerFile);
            } catch (err) {
                if (err.permanent) {
                    // A genuinely broken/wrong link (e.g. 404 - gallery removed or never
                    // existed) — mark it skipped-for-good instead of erroring every single
                    // run forever, and keep the batch moving to the next gallery.
                    saveSkippedToLibrary(id, err.message);
                    logActivity(`SKIPPED ID ${id}: ${err.message}`);
                    if (trackerFile) updateListStatus(trackerFile, id, `SKIPPED - ${err.message.substring(0, 60)}`);
                    this.emit('skipped', { galleryId: id, reason: err.message, currentTaskNum: i + 1, totalTasks: pendingIds.length });
                } else {
                    logError(id, err.message);
                    logActivity(`ERROR ID ${id}: ${err.message}`);
                    if (trackerFile) updateListStatus(trackerFile, id, `ERROR - ${err.message.substring(0, 30)}`);
                    this.emit('error', { galleryId: id, error: err.message, currentTaskNum: i + 1, totalTasks: pendingIds.length });
                }
            }

            // Cloudflare 429 Cooldown loop — escalating backoff + circuit breaker.
            // A fixed 5-minute wait that keeps retrying forever is exactly what turned one
            // 429 into a full Cloudflare JS-challenge IP flag: repeatedly poking a service
            // that just told you to back off makes things worse, not better. Every
            // consecutive 429 (across the whole run, not just this gallery) now doubles the
            // wait, and after too many in a row we stop entirely and require a human to look
            // instead of continuing to hammer it unattended.
            const MAX_CONSECUTIVE_RATE_LIMITS = 3;
            const BASE_RATE_LIMIT_WAIT = 5 * 60;
            const MAX_RATE_LIMIT_WAIT = 60 * 60;

            while (result && result.status === "RATE_LIMIT" && !this.isStopped) {
                this.consecutiveRateLimits++;

                if (this.consecutiveRateLimits > MAX_CONSECUTIVE_RATE_LIMITS) {
                    this.circuitBreakerTripped = true;
                    const msg = `Circuit breaker: ${this.consecutiveRateLimits - 1} consecutive rate limits — pausing the run entirely instead of continuing to hammer nhentai. Resume manually once the flag has had time to cool down.`;
                    logActivity(`CIRCUIT BREAKER: ${msg}`);
                    logError(id, msg);
                    this.emit('circuit_breaker', { galleryId: id, consecutiveRateLimits: this.consecutiveRateLimits - 1 });
                    this.pause();
                    if (trackerFile) updateListStatus(trackerFile, id, "PAUSED - Circuit breaker (too many 429s)");
                    break;
                }

                const waitSeconds = Math.min(BASE_RATE_LIMIT_WAIT * 2 ** (this.consecutiveRateLimits - 1), MAX_RATE_LIMIT_WAIT);
                logActivity(`RATE LIMIT ID ${id}: cooling down ${waitSeconds}s (consecutive hit #${this.consecutiveRateLimits})`);
                this.emit('rate_limit', { galleryId: id, waitSeconds, consecutiveRateLimits: this.consecutiveRateLimits });
                for (let s = waitSeconds; s > 0; s--) {
                    if (this.isStopped || this.forceRetry) break;
                    while (this.isPaused && !this.isStopped && !this.forceRetry) {
                        await sleep(500);
                    }
                    if (this.isStopped || this.forceRetry) break;

                    const m = Math.floor(s / 60);
                    const sRem = s % 60;
                    this.currentProgress = {
                        type: 'RATE_LIMIT',
                        title: `Rate Limit 429 - Cooldown IP (hit #${this.consecutiveRateLimits})`,
                        message: `Retrying in: ${m}m ${sRem}s`,
                        percent: Math.round(((waitSeconds - s) / waitSeconds) * 100),
                        remaining: s,
                        total: waitSeconds,
                        taskNum: i + 1,
                        totalTasks: pendingIds.length
                    };
                    this.emit('cooldown', this.currentProgress);
                    await sleep(1000);
                }
                if (this.forceRetry) {
                    this.forceRetry = false;
                    this.currentProgress = null;
                }
                result = await this.processGallery(id, i + 1, pendingIds.length, trackerFile);
            }

            if (this.circuitBreakerTripped) break;

            // Any real success (download OR a genuine metadata fetch that wasn't rate
            // limited) proves we're not currently flagged — safe to reset back to full speed.
            if (result && result.status !== "RATE_LIMIT") {
                this.consecutiveRateLimits = 0;
            }

            // Only a pure library.json/marker-file hit never touched the network at all — that
            // one gets a small "humanize" pause instead of the full anti-ban delay (a few
            // hundred of these costs low-single-digit minutes instead of hours, but it's never
            // a flat-out instant burst either). Any OTHER skip reason (found on disk only
            // after a real metadata fetch succeeded) DID make a real request to nhentai just
            // now and needs the same pacing a real download gets — it just skips the actual
            // page downloads afterward.
            const wasFreeSkip = !!(result && result.skipped && result.skipReason === 'library');

            if (wasFreeSkip && i < pendingIds.length - 1 && !this.isStopped) {
                await sleep(1000 + Math.floor(Math.random() * 2000));
            }

            if (i < pendingIds.length - 1 && !this.isStopped && !wasFreeSkip) {
                if ((i + 1) % this.batchSize === 0) {
                    const currentBatch = Math.ceil((i + 1) / this.batchSize);
                    const totalSeconds = this.batchRestMinutes * 60;
                    for (let s = totalSeconds; s > 0; s--) {
                        if (this.isStopped || this.forceRetry) break;
                        while (this.isPaused && !this.isStopped && !this.forceRetry) {
                            await sleep(500);
                        }
                        if (this.isStopped || this.forceRetry) break;

                        const m = Math.floor(s / 60);
                        const sRem = s % 60;
                        this.currentProgress = {
                            type: 'BATCH_REST',
                            title: `Batch ${currentBatch} Complete - Cooling Down (${this.batchRestMinutes} min)`,
                            message: `Next batch in: ${m}m ${sRem}s`,
                            percent: Math.round(((totalSeconds - s) / totalSeconds) * 100),
                            remaining: s,
                            total: totalSeconds,
                            taskNum: i + 1,
                            totalTasks: pendingIds.length
                        };
                        this.emit('cooldown', this.currentProgress);
                        await sleep(1000);
                    }
                    if (this.forceRetry) this.forceRetry = false;
                    this.currentProgress = null;
                } else {
                    const numPages = result ? result.numPages : 0;
                    const isSkipped = result ? result.skipped : false;
                    const dynamicDelay = getDynamicDelay(numPages, isSkipped);
                    const delaySeconds = Math.round(dynamicDelay / 1000);

                    for (let s = delaySeconds; s > 0; s--) {
                        if (this.isStopped || this.forceRetry) break;
                        while (this.isPaused && !this.isStopped && !this.forceRetry) {
                            await sleep(500);
                        }
                        if (this.isStopped || this.forceRetry) break;
                        this.currentProgress = {
                            type: 'COOLDOWN',
                            title: `Smart Delay Cooldown (Anti-Ban)`,
                            message: `Next in queue in: ${s}s`,
                            percent: Math.round(((delaySeconds - s) / delaySeconds) * 100),
                            remaining: s,
                            total: delaySeconds,
                            taskNum: i + 1,
                            totalTasks: pendingIds.length
                        };
                        this.emit('cooldown', this.currentProgress);
                        await sleep(1000);
                    }
                    if (this.forceRetry) this.forceRetry = false;
                    this.currentProgress = null;
                }
            }
        }

        this.isRunning = false;
        logActivity(`Run finished: ${pendingIds.length} galleries processed`);
        this.emit('batch_complete', { processed: pendingIds.length });
    }

    stop() {
        this.isStopped = true;
        this.isRunning = false;
        this.isPaused = false;
        // Deliberately NOT clearing this.currentProgress here: the UI keeps showing the
        // last-known snapshot (marked stale via `live: false`) instead of going blank,
        // so the user can tell what was happening instead of wondering if anything ran at all.
        if (this.currentProgress) this.currentProgress.live = false;
        this.emit('stopped');
    }

    async restart(galleryIds, trackerFile = null) {
        this.stop();
        this.forceRetry = true;
        await sleep(600);
        this.isStopped = false;
        this.isPaused = false;
        this.emit('restarted');
        return this.runBatch(galleryIds, trackerFile);
    }
}

module.exports = DownloaderEngine;
