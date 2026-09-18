#!/usr/bin/env node

const readline = require('readline');
const path = require('path');
const fs = require('fs');

const DownloaderEngine = require('../core/engine');
const { loadLibrary, syncListTracker } = require('../core/tracker');
const { sleep } = require('../core/utils');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

const engine = new DownloaderEngine();

let sigintCount = 0;
process.on('SIGINT', () => {
    if (sigintCount === 0) {
        process.stdout.write("\n\n[!] WARNING: Press Ctrl+C again to cancel the process.\n");
        process.stdout.write("[!] Progress (Autosave) has already been saved!\n");
        sigintCount++;
        setTimeout(() => { sigintCount = 0; }, 4000);
    } else {
        process.stdout.write("\n[+] Exiting program... Progress is safe!\n");
        engine.stop();
        process.exit(0);
    }
});

// Event Listeners for Terminal Output
engine.on('batch_start', ({ total, pending, skipped }) => {
    if (pending === 0) {
        console.log("\x1b[33m\n[-] No new IDs to download. Everything is already done.\x1b[0m");
    } else {
        console.log(`\x1b[32m\n[+] ${pending} unique galleries queued (Skipping ${skipped} already completed in Library).\x1b[0m`);
    }
});

engine.on('progress', ({ taskNum, totalTasks, galleryId, percent, completed, total }) => {
    process.stdout.write(`\x1b[2K\r[${taskNum}/${totalTasks}] [\x1b[36mDOWNLOAD\x1b[0m] ID: ${galleryId} | Progress: ${percent}% (${completed}/${total}) | Verifying File...`);
});

engine.on('cooldown', ({ message }) => {
    process.stdout.write(`\x1b[2K\r[!] ${message}`);
});

engine.on('done', ({ taskNum, totalTasks, galleryId, title, pages }) => {
    process.stdout.write(`\x1b[2K\r[${taskNum}/${totalTasks}] [\x1b[32mDONE\x1b[0m] ID: ${galleryId} | Title: ${title.substring(0, 25)}... | ${pages}/${pages} Pages\n`);
});

engine.on('skipped', ({ taskNum, totalTasks, galleryId, title, reason }) => {
    process.stdout.write(`\x1b[2K\r[${taskNum}/${totalTasks}] [\x1b[32mSKIP\x1b[0m] ID: ${galleryId} | Title: ${title.substring(0, 25)}... | ${reason}\n`);
});

engine.on('error', ({ galleryId, error }) => {
    process.stdout.write(`\x1b[2K\r\x1b[31m[-] Failed to process gallery ${galleryId}: ${error}\x1b[0m\n`);
});

engine.on('batch_complete', ({ processed }) => {
    process.stdout.write(`\x1b[2K\r`);
    console.log(`\x1b[32m\n=================================================\x1b[0m`);
    console.log(`\x1b[32m[+] ALL PROCESSES COMPLETE! (${processed} Galleries Processed)\x1b[0m`);
    console.log(`\x1b[32m[+] Results saved to: ${engine.baseDownloadDir}\x1b[0m`);
});

async function menu(skipClear = false) {
    if (!skipClear) console.clear();
    console.log(`\x1b[36m`);
    console.log(`=============================================================`);
    console.log(`   NHENTAI BATCH DOWNLOADER (CLI EDITION - ZERO DEPENDENCY)`);
    console.log(`=============================================================\x1b[0m\n`);
    console.log(` 1. Download from 1 ID/URL (Or paste ID/URL directly below!)`);
    console.log(` 2. Bulk Download from File (e.g., list.txt)`);
    console.log(` 3. Check Library Status`);
    console.log(` 4. Exit\n`);

    const choice = await prompt("Choose Menu (1-4) OR Paste Link / ID: ");
    const choiceStr = choice.trim();

    let galleryIds = [];
    const urlMatches = choiceStr.match(/nhentai\.net\/g\/(\d+)/);

    if (urlMatches) {
        galleryIds.push(urlMatches[1]);
    } else if (/^\d+$/.test(choiceStr) && !['1', '2', '3', '4'].includes(choiceStr)) {
        galleryIds.push(choiceStr);
    } else if (choiceStr === '1') {
        const input = await prompt("\nEnter Gallery URL or ID: ");
        const match = input.match(/\d+/);
        if (match) galleryIds.push(match[0]);
    } else if (choiceStr === '2') {
        const defaultList = path.join(__dirname, '..', 'list.txt');
        const customList = await prompt(`\nList file path (default: list.txt): `);
        const listPath = customList.trim() ? path.resolve(customList.trim()) : defaultList;

        const synced = syncListTracker(listPath);
        if (synced && synced.galleryIds.length > 0) {
            await engine.runBatch(synced.galleryIds, synced.trackerFile);
            await prompt("\nPress ENTER to return to Main Menu...");
            return menu();
        } else {
            console.log("\x1b[31m[-] File not found or empty!\x1b[0m");
            await sleep(2500);
            return menu();
        }
    } else if (choiceStr === '3') {
        const library = loadLibrary();
        console.log(`\n[+] There are ${Object.keys(library).length} galleries stored in the Library.`);
        await sleep(3500);
        return menu();
    } else if (choiceStr === '4' || choiceStr.toLowerCase() === 'exit') {
        console.log("\nExiting...");
        rl.close();
        process.exit(0);
    } else {
        return menu();
    }

    if (galleryIds.length > 0) {
        await engine.runBatch(galleryIds);
        return menu(true);
    }

    return menu();
}

async function start() {
    const args = process.argv.slice(2);
    if (args.length > 0) {
        let input = args[0];
        let galleryIds = [];
        let trackerFile = null;

        if (input.toLowerCase().endsWith('.txt')) {
            const listPath = path.resolve(input);
            const synced = syncListTracker(listPath);
            if (synced) {
                galleryIds = synced.galleryIds;
                trackerFile = synced.trackerFile;
            } else {
                console.log(`\x1b[31m[-] File ${input} not found!\x1b[0m`);
                process.exit(1);
            }
        } else {
            const match = input.match(/\d+/);
            if (match) galleryIds.push(match[0]);
        }

        if (galleryIds.length > 0) {
            await engine.runBatch(galleryIds, trackerFile);
            process.exit(0);
        }
    } else {
        await menu();
    }
}

start();
