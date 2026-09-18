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

module.exports = { loadEnvFile };
