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

// Windows curl builds (schannel TLS backend) do an online certificate-revocation check by
// default, which regularly fails with CRYPT_E_REVOCATION_OFFLINE on flaky networks and
// aborts an otherwise-fine connection. --ssl-no-revoke is curl's own documented workaround
// for this specific schannel quirk; no equivalent issue exists on the OpenSSL builds Linux
// containers use, so this is a no-op there.
const CURL_EXTRA_FLAGS = process.platform === 'win32' ? '--ssl-no-revoke' : '';

// curl's own exit codes for the failure modes we actually hit in practice — used so log
// lines say "connection timed out" instead of dumping the whole failed command (which,
// for the download endpoints, includes a multi-KB presigned URL with base64 metadata).
const CURL_EXIT_REASONS = {
    6: 'gagal resolve host',
    7: 'gagal connect',
    18: 'transfer terputus di tengah',
    28: 'timeout (koneksi macet)',
    35: 'SSL handshake gagal',
    52: 'server balikin response kosong',
    56: 'koneksi putus saat baca data'
};

// Turns a child_process exec() error into a short, log-safe reason — never echoes the
// full command (which may embed a huge presigned URL) back into activity.log.
function cleanExecError(e) {
    if (e.killed || e.signal) return `timeout/dibunuh paksa (${e.signal || 'SIGTERM'})`;
    if (typeof e.code === 'number' && CURL_EXIT_REASONS[e.code]) return `curl exit ${e.code}: ${CURL_EXIT_REASONS[e.code]}`;
    if (typeof e.code === 'number') return `curl exit ${e.code}`;
    return (e.message || 'unknown error').split('\n')[0].slice(0, 150);
}

// Confirms an API key actually authenticates against nhentai's v2 API before we
// commit to using it — GET /api/v2/user returns 401 on a bad/expired key and
// 200 (with the account profile) on a good one, so it's the cheapest possible check.
async function verifyApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return { valid: false, error: 'API key kosong' };
    }

    const curlCmd = `${CURL_BIN} -skL ${CURL_EXTRA_FLAGS} -o NUL -w "%{http_code}" --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -H "Authorization: Key ${apiKey.trim()}" https://nhentai.net/api/v2/user`;
    const curlCmdUnix = curlCmd.replace(' -o NUL ', ' -o /dev/null ');

    try {
        const { stdout } = await execAsync(process.platform === 'win32' ? curlCmd : curlCmdUnix, { encoding: 'utf-8', windowsHide: true });
        const status = stdout.trim();
        if (status === '200') return { valid: true };
        if (status === '401') return { valid: false, error: 'API key ditolak (401 Unauthorized)' };
        if (status === '429') return { valid: false, error: 'Kena rate limit (429), coba lagi nanti' };
        return { valid: false, error: `Response tak terduga (HTTP ${status || 'unknown'})` };
    } catch (e) {
        return { valid: false, error: `Gagal menghubungi nhentai: ${cleanExecError(e)}` };
    }
}

// Fetches full gallery metadata from the official JSON API — public, no API key required
// (a key just raises the rate limit from 20/min to 45/min per IP). Returns the raw parsed
// response untouched so callers can keep every field (tags, favorites, both title
// variants, scanlator, etc.) instead of only the few fetchMetadata() historically needed.
async function fetchGalleryMetadata(galleryId, apiKey) {
    const authHeader = apiKey ? `-H "Authorization: Key ${apiKey}"` : '';
    const curlCmd = `${CURL_BIN} -skL ${CURL_EXTRA_FLAGS} --connect-timeout 10 --max-time 30 --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" ${authHeader} "https://nhentai.net/api/v2/galleries/${galleryId}"`;

    try {
        const { stdout } = await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 * 10, timeout: 35000 });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch (e) {
            return { success: false, reason: `Response bukan JSON valid: ${stdout.slice(0, 200)}` };
        }
        if (parsed && parsed.id && Array.isArray(parsed.pages)) {
            return { success: true, data: parsed };
        }
        return { success: false, reason: parsed.error || 'Response tidak punya field id/pages', notFound: /not.?found/i.test(parsed.error || '') };
    } catch (e) {
        return { success: false, reason: `Gagal request metadata: ${cleanExecError(e)}` };
    }
}

// Asks the official API for a short-lived download URL for the whole gallery as one
// archive (format: 'zip' | 'cbz'). This is the "fast path" — one request instead of one
// per page — but it's gated behind the account's `allow_downloads` feature flag and a
// tight rate limit (10/5min per IP), so callers must treat any failure as "fall back to
// the old per-page CDN download", not as a hard error.
async function requestDownloadUrl(galleryId, format, apiKey) {
    const fmt = format === 'zip' ? 'zip' : 'cbz';
    const curlCmd = `${CURL_BIN} -skL ${CURL_EXTRA_FLAGS} --connect-timeout 10 --max-time 30 -X POST --resolve nhentai.net:443:${NHENTAI_MAIN_IP} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -H "Authorization: Key ${apiKey}" "https://nhentai.net/api/v2/galleries/${galleryId}/download?format=${fmt}"`;

    try {
        const { stdout } = await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true, timeout: 35000 });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch (e) {
            return { success: false, reason: `Response bukan JSON valid: ${stdout.slice(0, 200)}` };
        }
        if (parsed && parsed.url && parsed.expires_at) {
            return { success: true, url: parsed.url, expiresAt: parsed.expires_at };
        }
        return { success: false, reason: parsed.error || 'Response tidak punya field url/expires_at' };
    } catch (e) {
        return { success: false, reason: `Gagal request download URL: ${cleanExecError(e)}` };
    }
}

// Downloads the (presigned, non-nhentai.net) archive URL straight to disk. No IP pinning
// here — the URL points at whatever CDN/storage the API handed back, not the
// Cloudflare-fronted nhentai.net domain, so a plain curl fetch is fine.
// Retries twice on transient failures (a cold connection blip shouldn't force a fall back
// to the much slower per-page CDN path) before giving up — the presigned URL is usually
// valid for a couple minutes, so a short retry window doesn't risk it expiring mid-retry.
async function downloadArchiveFile(url, destPath, attempts = 3) {
    // --connect-timeout / --max-time bound the whole request; --speed-limit + --speed-time
    // abort if the transfer stalls (drops under ~1KB/s for 15s straight) instead of hanging
    // forever on a half-open connection — the `timeout` exec option below is a hard backstop
    // in case curl itself ignores those flags for some reason.
    const curlCmd = `${CURL_BIN} -skL ${CURL_EXTRA_FLAGS} --connect-timeout 10 --max-time 180 --speed-limit 1000 --speed-time 15 -o "${destPath}" "${url}"`;
    let lastReason = '';

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await execAsync(curlCmd, { encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 * 10, timeout: 200000 });
            if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
                lastReason = 'File hasil download kosong/gagal ditulis';
            } else {
                return { success: true };
            }
        } catch (e) {
            lastReason = `Gagal download archive: ${cleanExecError(e)}`;
        }
        if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (e2) {} }
        if (attempt < attempts) await new Promise(r => setTimeout(r, 1000 * attempt));
    }

    return { success: false, reason: lastReason };
}

module.exports = { verifyApiKey, fetchGalleryMetadata, requestDownloadUrl, downloadArchiveFile };
