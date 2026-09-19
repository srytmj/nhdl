const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const fs = require('fs');

const NHENTAI_MAIN_IP = '104.26.4.188';

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

// Confirms an API key actually authenticates against nhentai's v2 API before we
// commit to using it — GET /api/v2/user returns 401 on a bad/expired key and
// 200 (with the account profile) on a good one, so it's the cheapest possible check.
async function verifyApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return { valid: false, error: 'API key kosong' };
    }

    const curlCmd = `${CURL_BIN} -skL -o NUL -w "%{http_code}" --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -H "Authorization: Key ${apiKey.trim()}" https://nhentai.net/api/v2/user`;
    const curlCmdUnix = curlCmd.replace(' -o NUL ', ' -o /dev/null ');

    try {
        const { stdout } = await execAsync(process.platform === 'win32' ? curlCmd : curlCmdUnix, { encoding: 'utf-8', windowsHide: true });
        const status = stdout.trim();
        if (status === '200') return { valid: true };
        if (status === '401') return { valid: false, error: 'API key ditolak (401 Unauthorized)' };
        if (status === '429') return { valid: false, error: 'Kena rate limit (429), coba lagi nanti' };
        return { valid: false, error: `Response tak terduga (HTTP ${status || 'unknown'})` };
    } catch (e) {
        return { valid: false, error: `Gagal menghubungi nhentai: ${e.message}` };
    }
}

// Fetches full gallery metadata from the official JSON API — public, no API key required
// (a key just raises the rate limit from 20/min to 45/min per IP). Returns the raw parsed
// response untouched so callers can keep every field (tags, favorites, both title
// variants, scanlator, etc.) instead of only the few fetchMetadata() historically needed.
async function fetchGalleryMetadata(galleryId, apiKey) {
    const authHeader = apiKey ? `-H "Authorization: Key ${apiKey}"` : '';
    const curlCmd = `${CURL_BIN} -skL --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" ${authHeader} "https://nhentai.net/api/v2/galleries/${galleryId}"`;

    try {
        const { stdout } = await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 * 10 });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch (e) {
            return { success: false, reason: `Response bukan JSON valid: ${stdout.slice(0, 200)}` };
        }
        if (parsed && parsed.id && Array.isArray(parsed.pages)) {
            return { success: true, data: parsed };
        }
        return { success: false, reason: parsed.error || 'Response tidak punya field id/pages', notFound: /not.?found/i.test(parsed.error || '') };
    } catch (e) {
        return { success: false, reason: `Gagal request metadata: ${e.message}` };
    }
}

// Asks the official API for a short-lived download URL for the whole gallery as one
// archive (format: 'zip' | 'cbz'). This is the "fast path" — one request instead of one
// per page — but it's gated behind the account's `allow_downloads` feature flag and a
// tight rate limit (10/5min per IP), so callers must treat any failure as "fall back to
// the old per-page CDN download", not as a hard error.
async function requestDownloadUrl(galleryId, format, apiKey) {
    const fmt = format === 'zip' ? 'zip' : 'cbz';
    const curlCmd = `${CURL_BIN} -skL -X POST --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -H "Authorization: Key ${apiKey}" "https://nhentai.net/api/v2/galleries/${galleryId}/download?format=${fmt}"`;

    try {
        const { stdout } = await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch (e) {
            return { success: false, reason: `Response bukan JSON valid: ${stdout.slice(0, 200)}` };
        }
        if (parsed && parsed.url && parsed.expires_at) {
            return { success: true, url: parsed.url, expiresAt: parsed.expires_at };
        }
        return { success: false, reason: parsed.error || 'Response tidak punya field url/expires_at' };
    } catch (e) {
        return { success: false, reason: `Gagal request download URL: ${e.message}` };
    }
}

// Downloads the (presigned, non-nhentai.net) archive URL straight to disk. No IP pinning
// here — the URL points at whatever CDN/storage the API handed back, not the
// Cloudflare-fronted nhentai.net domain, so a plain curl fetch is fine.
async function downloadArchiveFile(url, destPath) {
    const curlCmd = `${CURL_BIN} -skL -o "${destPath}" "${url}"`;
    try {
        await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 * 10 });
        if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
            return { success: false, reason: 'File hasil download kosong/gagal ditulis' };
        }
        return { success: true };
    } catch (e) {
        return { success: false, reason: `Gagal download archive: ${e.message}` };
    }
}

module.exports = { verifyApiKey, fetchGalleryMetadata, requestDownloadUrl, downloadArchiveFile };
