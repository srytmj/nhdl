const EventEmitter = require('events');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const { sanitizeName, toTitleCase, getDynamicDelay, verifyImage, sleep } = require('./utils');
const { loadLibrary, saveToLibrary, logError, updateListStatus, isLibraryEntryValid, buildDisplayName, updateListDisplayName, trackerFileToListPath, compressLibraryEntry, getBatchFormatForGallery } = require('./tracker');
const { logActivity } = require('./logger');

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
    }

    pause() {
        this.isPaused = true;
        this.emit('paused');
    }

    resume() {
        this.isPaused = false;
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
        try {
            let cfg = {};
            if (fs.existsSync(CONFIG_FILE)) {
                try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
            }
            cfg.downloadDir = this.baseDownloadDir;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
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
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
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
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
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
            throw new Error("404 Page (Gallery not found / already removed)");
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
                return { status: "SUCCESS", numPages: data.pages, skipped: true };
            }
        }

        const meta = await this.fetchMetadata(galleryId);
        if (meta.status === "RATE_LIMIT") {
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

        const folderPath = path.join(this.baseDownloadDir, sanitizedLang, sanitizedAuthor, sanitizedTitle);
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
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
            return { status: "SUCCESS", numPages, skipped: true };
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
        const pendingIds = uniqueIds.filter(id => !isLibraryEntryValid(library[id]));

        this.emit('batch_start', { total: uniqueIds.length, pending: pendingIds.length, skipped: uniqueIds.length - pendingIds.length });
        logActivity(`Run started: ${pendingIds.length} pending / ${uniqueIds.length} total (${uniqueIds.length - pendingIds.length} already in library)`);

        if (pendingIds.length === 0) {
            this.isRunning = false;
            this.emit('batch_complete', { processed: 0 });
            return;
        }

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
                logError(id, err.message);
                logActivity(`ERROR ID ${id}: ${err.message}`);
                if (trackerFile) updateListStatus(trackerFile, id, `ERROR - ${err.message.substring(0, 30)}`);
                this.emit('error', { galleryId: id, error: err.message, currentTaskNum: i + 1, totalTasks: pendingIds.length });
            }

            // Cloudflare 429 Cooldown loop
            while (result && result.status === "RATE_LIMIT" && !this.isStopped) {
                const waitSeconds = 5 * 60;
                logActivity(`RATE LIMIT ID ${id}: cooling down ${waitSeconds}s`);
                this.emit('rate_limit', { galleryId: id, waitSeconds });
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
                        title: `Rate Limit 429 - Cooldown IP`,
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

            if (i < pendingIds.length - 1 && !this.isStopped) {
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
