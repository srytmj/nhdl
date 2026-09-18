const fs = require('fs');

function sanitizeName(name) {
    if (!name) return "";
    let decoded = name
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    return decoded
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function toTitleCase(str) {
    if (!str) return "";
    return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

function getDynamicDelay(numPages, isSkipped) {
    let min = 15000;
    let max = 25000;
    
    if (isSkipped) {
        min = 20000;
        max = 35000;
    } else if (numPages > 0 && numPages < 15) {
        min = 25000;
        max = 40000;
    } else if (numPages >= 15 && numPages < 40) {
        min = 15000;
        max = 25000;
    } else {
        min = 10000;
        max = 18000;
    }
    
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function verifyImage(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const stats = fs.statSync(filePath);
    return stats.size >= 2048;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractGalleries(text) {
    if (!text || typeof text !== 'string') return [];
    const results = [];
    const seen = new Set();

    const urlRegex = /https?:\/\/nhentai\.net\/g\/(\d+)\b\/?/gi;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
        const id = match[1];
        if (!seen.has(id)) {
            seen.add(id);
            results.push(`https://nhentai.net/g/${id}/`);
        }
    }

    if (results.length === 0) {
        const idRegex = /\b\d{5,7}\b/g;
        while ((match = idRegex.exec(text)) !== null) {
            const id = match[0];
            if (!seen.has(id)) {
                seen.add(id);
                results.push(`https://nhentai.net/g/${id}/`);
            }
        }
    }

    return results;
}

module.exports = {
    sanitizeName,
    toTitleCase,
    getDynamicDelay,
    verifyImage,
    sleep,
    extractGalleries
};
