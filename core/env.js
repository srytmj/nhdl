const fs = require('fs');
const path = require('path');

// Minimal .env loader (no npm dependency) — reads KEY=VALUE lines from a .env file at the
// project root and fills in process.env for any key not already set by the real
// environment (so `docker run -e` / docker-compose env vars always win over the file).
function loadEnvFile(rootDir) {
    const envPath = path.join(rootDir, '.env');
    if (!fs.existsSync(envPath)) return;

    try {
        const content = fs.readFileSync(envPath, 'utf-8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eq = trimmed.indexOf('=');
            if (eq === -1) return;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && process.env[key] === undefined) {
                process.env[key] = value;
            }
        });
    } catch (e) {}
}

// Writes/updates a single KEY=VALUE line in .env, preserving every other line
// (comments, blank lines, other keys) as-is. Creates the file if it doesn't exist yet.
function saveEnvValue(rootDir, key, value) {
    const envPath = path.join(rootDir, '.env');
    let lines = [];
    if (fs.existsSync(envPath)) {
        lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    }

    let found = false;
    const newLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed === '') return line;
        const eq = trimmed.indexOf('=');
        if (eq === -1) return line;
        const lineKey = trimmed.slice(0, eq).trim();
        if (lineKey === key) {
            found = true;
            return `${key}=${value}`;
        }
        return line;
    });

    if (!found) {
        if (newLines.length && newLines[newLines.length - 1].trim() !== '') newLines.push('');
        newLines.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
    process.env[key] = value;
}

module.exports = { loadEnvFile, saveEnvValue };
