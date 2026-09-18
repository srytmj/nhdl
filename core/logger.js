const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ACTIVITY_LOG = path.join(ROOT_DIR, 'activity.log');
const MAX_LOG_LINES = 5000;

// Full audit trail of everything the app does (queue edits, downloads, control actions,
// renames, compresses, rescans, config changes) — separate from error.log, which only
// holds failures. Capped so it stays a normal-sized text file instead of growing forever.
function logActivity(message) {
    try {
        const time = new Date().toISOString();
        fs.appendFileSync(ACTIVITY_LOG, `[${time}] ${message}\n`, 'utf-8');

        const content = fs.readFileSync(ACTIVITY_LOG, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim() !== '');
        if (lines.length > MAX_LOG_LINES) {
            const trimmed = lines.slice(lines.length - MAX_LOG_LINES);
            fs.writeFileSync(ACTIVITY_LOG, trimmed.join('\n') + '\n', 'utf-8');
        }
    } catch (e) {}
}

function readActivityLog() {
    try {
        return fs.existsSync(ACTIVITY_LOG) ? fs.readFileSync(ACTIVITY_LOG, 'utf-8') : '';
    } catch (e) {
        return '';
    }
}

module.exports = { logActivity, readActivityLog, ACTIVITY_LOG };
