const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
// Lives inside the active download dir (a persistent volume) instead of ROOT_DIR (the
// container's writable layer, wiped on every image rebuild) — see setLogDir().
let ACTIVITY_LOG = path.join(ROOT_DIR, 'activity.log');
const MAX_LOG_LINES = 5000;

function setLogDir(dir) {
    if (dir) ACTIVITY_LOG = path.join(dir, 'activity.log');
}

// Full audit trail of everything the app does (queue edits, downloads, control actions,
// renames, compresses, rescans, config changes) — separate from error.log, which only
// holds failures. Capped so it stays a normal-sized text file instead of growing forever.
function logActivity(message) {
    const time = new Date().toISOString();
    const line = `[${time}] ${message}`;
    try {
        fs.appendFileSync(ACTIVITY_LOG, line + '\n', 'utf-8');

        const content = fs.readFileSync(ACTIVITY_LOG, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim() !== '');
        if (lines.length > MAX_LOG_LINES) {
            const trimmed = lines.slice(lines.length - MAX_LOG_LINES);
            fs.writeFileSync(ACTIVITY_LOG, trimmed.join('\n') + '\n', 'utf-8');
        }
    } catch (e) {
        // Can't write activity.log (e.g. disk went read-only) — still surface it via
        // stdout so `docker logs` captures it instead of the app going silent.
        console.log(`${line} [activity.log write failed: ${e.code || e.message}]`);
    }
}

function readActivityLog() {
    try {
        return fs.existsSync(ACTIVITY_LOG) ? fs.readFileSync(ACTIVITY_LOG, 'utf-8') : '';
    } catch (e) {
        return '';
    }
}

module.exports = { logActivity, readActivityLog, setLogDir, get ACTIVITY_LOG() { return ACTIVITY_LOG; } };
