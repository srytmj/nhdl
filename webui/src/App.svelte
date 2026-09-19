<script>
    import { onMount } from 'svelte';
    import { fade, slide, fly, scale } from 'svelte/transition';
    import { flip } from 'svelte/animate';
    import { gsap } from 'gsap';
    import {
        Trash2, ExternalLink, Play, Pause, AlertTriangle, Terminal,
        Activity, FileDigit, Clock, Folder, FolderOpen,
        ArrowUp, RotateCcw, Check, X, HardDrive, Square, Moon,
        Library, Search, BookOpen, Pencil, Archive, PackageCheck,
        ChevronRight, ChevronDown, ScrollText, Download, CheckSquare, LogOut
    } from 'lucide-svelte';

    let authRequired = false;

    async function logout() {
        try {
            await fetch('/api/logout', { method: 'POST' });
        } catch (e) {}
        window.location.reload();
    }

    function focusOnMount(node) {
        node.focus();
        node.select();
    }

    let items = [];
    let errors = '';
    let rawList = '';
    let newUrl = '';
    let liveProgress = null;
    let engineStatus = 'IDLE';
    let confirmDelete = null;
    let extractNotice = '';

    $: doneCount = items.filter(i => i.status.includes('DONE')).length;

    // The HUD is always rendered (never conditionally mounted/unmounted) so its entrance/exit
    // never causes a layout jump; when there's nothing live, `hud` falls back to a stable idle shape.
    $: hud = liveProgress || { idle: true, percent: 0, title: 'No active task', galleryId: null, activePages: [], type: 'IDLE' };

    // Group the flat item list into per-insert "batches" (see "# BATCH N" markers written
    // in appendToList). Manual collapse state is per batch number; the batch containing
    // whatever's actively downloading always forces itself open.
    let manuallyCollapsed = new Set();

    function toggleBatch(num) {
        const next = new Set(manuallyCollapsed);
        if (next.has(num)) next.delete(num); else next.add(num);
        manuallyCollapsed = next;
    }

    $: activeBatchNum = (() => {
        if (!hud.galleryId) return null;
        const activeItem = items.find(i => i.url.includes(`/g/${hud.galleryId}/`));
        return activeItem ? (activeItem.batch || 1) : null;
    })();

    $: batches = (() => {
        const map = new Map();
        items.forEach(item => {
            const b = item.batch || 1;
            if (!map.has(b)) map.set(b, []);
            map.get(b).push(item);
        });
        return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([num, its]) => ({
            num,
            items: its,
            done: its.filter(i => i.status.includes('DONE')).length,
            total: its.length,
            collapsed: num !== activeBatchNum && manuallyCollapsed.has(num)
        }));
    })();

    // Folder Picker State (Jellyfin Style)
    let downloadDir = '';
    let showFolderPicker = false;
    let browsePath = '';
    let browseParent = null;
    let browseDrives = [];
    let browseDirectories = [];
    let browseLoading = false;
    let selectedDir = '';
    let retryFeedback = '';

    // Library Panel State (full download history, independent of the current queue/list.txt)
    let showLibrary = false;
    let libraryItems = [];
    let libraryTotal = 0;
    let libraryLoading = false;
    let librarySearch = '';

    $: filteredLibrary = librarySearch.trim()
        ? libraryItems.filter(i =>
            i.title.toLowerCase().includes(librarySearch.toLowerCase()) ||
            (i.author && i.author.toLowerCase().includes(librarySearch.toLowerCase())) ||
            i.id.includes(librarySearch.trim())
        )
        : libraryItems;

    // Checklist selection for batch-converting multiple library entries to .cbz/.zip at once.
    let selectedLibraryIds = new Set();
    let batchConverting = false;
    let batchConvertFeedback = '';

    function toggleLibrarySelect(id) {
        const next = new Set(selectedLibraryIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        selectedLibraryIds = next;
    }

    function selectAllVisibleLibrary() {
        selectedLibraryIds = new Set(filteredLibrary.map(i => i.id));
    }

    function clearLibrarySelection() {
        selectedLibraryIds = new Set();
    }

    // The actual compression runs as a background job on the server (see server/index.js),
    // so it keeps going even if this tab is closed mid-batch — we just poll its progress.
    // If the panel is reopened later (or the batch was started from another tab), polling
    // picks the running/finished job back up instead of losing track of it.
    let compressJobProgress = null;
    let compressPollTimer = null;

    async function pollCompressJob() {
        try {
            const res = await fetch('/api/library/compress-status');
            const data = await res.json();
            compressJobProgress = data.job;

            if (compressJobProgress && !compressJobProgress.finishedAt) {
                compressPollTimer = setTimeout(pollCompressJob, 500);
            } else if (compressJobProgress && compressJobProgress.finishedAt) {
                const j = compressJobProgress;
                const parts = [`Converted ${j.converted}`];
                if (j.skipped > 0) parts.push(`${j.skipped} already compressed (skipped)`);
                if (j.failed > 0) parts.push(`${j.failed} failed`);
                batchConvertFeedback = parts.join(', ');
                batchConverting = false;
                compressJobProgress = null;
                selectedLibraryIds = new Set();
                await openLibrary();
                setTimeout(() => { batchConvertFeedback = ''; }, 5000);
            }
        } catch (e) {
            batchConverting = false;
        }
    }

    async function batchConvertSelected(ext = 'cbz') {
        if (selectedLibraryIds.size === 0) return;
        batchConverting = true;
        batchConvertFeedback = '';
        clearTimeout(compressPollTimer);
        try {
            const res = await fetch('/api/library/batch-compress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [...selectedLibraryIds], ext })
            });
            const data = await res.json();
            if (data.success) {
                pollCompressJob();
            } else {
                batchConvertFeedback = data.error || 'Batch convert failed';
                batchConverting = false;
                setTimeout(() => { batchConvertFeedback = ''; }, 5000);
            }
        } catch (e) {
            batchConvertFeedback = 'Batch convert failed';
            batchConverting = false;
            setTimeout(() => { batchConvertFeedback = ''; }, 5000);
        }
    }

    // Picks a batch compress already running server-side back up (e.g. reopening the
    // Library panel, or another browser tab/window started it) so progress isn't lost.
    async function checkForRunningCompressJob() {
        try {
            const res = await fetch('/api/library/compress-status');
            const data = await res.json();
            if (data.job && !data.job.finishedAt) {
                batchConverting = true;
                pollCompressJob();
            }
        } catch (e) {}
    }

    async function openLibrary() {
        showLibrary = true;
        libraryLoading = true;
        try {
            const res = await fetch('/api/library');
            const data = await res.json();
            libraryItems = data.items || [];
            libraryTotal = data.total || 0;
        } catch (e) {
            console.error('Failed to load library', e);
        } finally {
            libraryLoading = false;
        }
        if (!batchConverting) checkForRunningCompressJob();
    }

    function requeueFromLibrary(id) {
        const already = existingIds();
        if (already.has(id)) return;
        rawList += (rawList.endsWith('\n') || rawList === '' ? '' : '\n') + `https://nhentai.net/g/${id}/`;
        saveList();
    }

    let rescanning = false;
    let rescanFeedback = '';

    // On-demand only — this never runs on a timer. It walks the download folder once,
    // looking for the small marker file each gallery drops, so moved/renamed folders get
    // relinked without re-downloading anything.
    async function rescanLibraryNow() {
        rescanning = true;
        rescanFeedback = '';
        try {
            const res = await fetch('/api/library/rescan', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                const parts = [];
                if (data.relocated > 0) parts.push(`relinked ${data.relocated} moved folder${data.relocated !== 1 ? 's' : ''}`);
                if (data.pruned > 0) parts.push(`removed ${data.pruned} entr${data.pruned !== 1 ? 'ies' : 'y'} with no folder on disk`);
                rescanFeedback = parts.length > 0 ? parts.join(', ') : 'Everything already matches disk — nothing to change';
                await openLibrary();
            } else {
                rescanFeedback = 'Rescan failed';
            }
        } catch (e) {
            rescanFeedback = 'Rescan failed';
        } finally {
            rescanning = false;
            setTimeout(() => { rescanFeedback = ''; }, 4000);
        }
    }

    // Inline rename — no need to open Explorer. Renames the folder/.cbz on disk and updates
    // library.json + the queue's display line to match.
    let renamingId = null;
    let renameValue = '';
    let renameBusy = false;

    function startRename(entry) {
        renamingId = entry.id;
        renameValue = entry.title;
    }

    function cancelRename() {
        renamingId = null;
        renameValue = '';
    }

    async function submitRename(id) {
        if (!renameValue.trim()) return;
        renameBusy = true;
        try {
            const res = await fetch('/api/library/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, newName: renameValue.trim() })
            });
            const data = await res.json();
            if (data.success) {
                renamingId = null;
                await openLibrary();
                fetchStatus();
            } else {
                alert(data.error || 'Rename failed');
            }
        } catch (e) {
            alert('Rename failed');
        } finally {
            renameBusy = false;
        }
    }

    // Compress a still-in-folder gallery into a .cbz on demand. Only runs when clicked —
    // reads the pages already on disk and zips them, no network involved.
    let compressingId = null;

    async function compressEntry(id) {
        compressingId = id;
        try {
            const res = await fetch('/api/library/compress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data.success) {
                await openLibrary();
            } else {
                alert(data.error || 'Compress failed');
            }
        } catch (e) {
            alert('Compress failed');
        } finally {
            compressingId = null;
        }
    }

    async function fetchStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            // Defense in depth: dedupe by URL client-side too, so a stray duplicate can
            // never crash the keyed {#each} below regardless of what the backend sends.
            const seenUrls = new Set();
            items = (data.items || []).filter(i => {
                if (seenUrls.has(i.url)) return false;
                seenUrls.add(i.url);
                return true;
            });
            errors = data.errors;
            rawList = data.rawList;
            liveProgress = data.liveProgress;
            if (data.engineStatus) engineStatus = data.engineStatus;
            if (typeof data.autoContinueBatches === 'boolean') autoContinueBatches = data.autoContinueBatches;
        } catch(e) {
            console.error("API Unreachable");
        }
    }

    let downloadFormat = 'folder';
    let autoContinueBatches = true;

    // nhentai v2 API key — stored server-side in .env (survives restarts), never
    // echoed back in full: /api/config only gives us a masked preview once saved.
    let apiKeyInput = '';
    let apiKeyConfigured = false;
    let apiKeyMasked = '';
    let apiKeyStatus = 'idle'; // idle | checking | valid | invalid | saving
    let apiKeyError = '';

    async function loadConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            if (data.downloadDir) {
                downloadDir = data.downloadDir;
                selectedDir = data.downloadDir;
            }
            if (data.downloadFormat) {
                downloadFormat = data.downloadFormat;
                insertFormat = data.downloadFormat;
            }
            if (typeof data.autoContinueBatches === 'boolean') autoContinueBatches = data.autoContinueBatches;
            if (typeof data.authRequired === 'boolean') authRequired = data.authRequired;
            apiKeyConfigured = !!data.apiKeyConfigured;
            apiKeyMasked = data.apiKeyMasked || '';
        } catch(e) {}
    }

    async function saveApiKey() {
        if (!apiKeyInput.trim()) return;
        apiKeyStatus = 'saving';
        apiKeyError = '';
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: apiKeyInput.trim() })
            });
            const data = await res.json();
            if (!data.success) {
                apiKeyStatus = 'idle';
                apiKeyError = data.error || 'Gagal menyimpan API key';
                return;
            }
            await verifyApiKey();
            await loadConfig();
            apiKeyInput = '';
        } catch (e) {
            apiKeyStatus = 'idle';
            apiKeyError = 'Gagal menyimpan API key';
        }
    }

    async function verifyApiKey() {
        apiKeyStatus = 'checking';
        apiKeyError = '';
        try {
            const res = await fetch('/api/config/verify-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: apiKeyInput.trim() || undefined })
            });
            const data = await res.json();
            if (data.valid) {
                apiKeyStatus = 'valid';
            } else {
                apiKeyStatus = 'invalid';
                apiKeyError = data.error || 'API key tidak valid';
            }
        } catch (e) {
            apiKeyStatus = 'invalid';
            apiKeyError = 'Gagal menghubungi server';
        }
    }

    async function setDownloadFormat(format) {
        downloadFormat = format;
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadFormat: format })
            });
        } catch (e) {}
    }

    async function setAutoContinueBatches(enabled) {
        autoContinueBatches = enabled;
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoContinueBatches: enabled })
            });
        } catch (e) {}
    }

    // Full audit log panel — everything the app has done, viewable and downloadable for
    // when the user wants to check what actually happened.
    let showLogs = false;
    let logText = '';
    let logsLoading = false;

    async function openLogs() {
        showLogs = true;
        logsLoading = true;
        try {
            const res = await fetch('/api/logs');
            const data = await res.json();
            logText = data.log || '';
        } catch (e) {
            logText = '';
        } finally {
            logsLoading = false;
        }
    }

    function downloadLogs() {
        window.open('/api/logs/download', '_blank');
    }

    onMount(() => {
        fetchStatus();
        loadConfig();
        const interval = setInterval(fetchStatus, 1000); // Poll setiap 1 detik
        
        gsap.from(".reveal-item", {
            y: 12,
            opacity: 0,
            duration: 0.3,
            stagger: 0.04,
            ease: "power1.out"
        });

        return () => clearInterval(interval);
    });

    async function saveList() {
        try {
            await fetch('/api/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: rawList })
            });
            fetchStatus();
        } catch(e) {
            alert("Connection error");
        }
    }

    // Smart Gallery Extraction from any arbitrary or clumped text
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

    function existingIds() {
        const ids = new Set();
        rawList.split('\n').forEach(line => {
            const m = line.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b/);
            if (m) ids.add(m[1]);
        });
        return ids;
    }

    // Each "ADD TO QUEUE" click gets its own "# BATCH N" marker line so the queue can be
    // grouped visually — untagged content that predates this feature is implicitly batch 1.
    function nextBatchNumber() {
        const matches = [...rawList.matchAll(/^#\s*BATCH\s+(\d+)/gim)];
        if (matches.length > 0) {
            return Math.max(...matches.map(m => parseInt(m[1], 10))) + 1;
        }
        const hasUntaggedContent = rawList.split('\n').some(l => l.trim() && !l.trim().startsWith('#'));
        return hasUntaggedContent ? 2 : 1;
    }

    // Drops any "# BATCH N" header left with nothing under it (e.g. after every item in
    // that batch was removed/cleared), so the queue never shows an empty batch group.
    function stripEmptyBatchHeaders(text) {
        const lines = text.split('\n');
        const result = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^#\s*BATCH\s+\d+/i.test(line.trim())) {
                let hasContent = false;
                for (let j = i + 1; j < lines.length; j++) {
                    const next = lines[j].trim();
                    if (/^#\s*BATCH\s+\d+/i.test(next)) break;
                    if (next !== '' && !next.startsWith('#')) { hasContent = true; break; }
                }
                if (!hasContent) continue;
            }
            result.push(line);
        }
        return result.join('\n');
    }

    let insertFormat = 'folder';

    async function appendToList() {
        if (!newUrl.trim()) return;
        const extracted = extractGalleries(newUrl.trim());
        const already = existingIds();

        if (extracted.length > 0) {
            const fresh = extracted.filter(url => {
                const m = url.match(/\/g\/(\d+)\//);
                return m && !already.has(m[1]);
            });
            const skipped = extracted.length - fresh.length;

            if (fresh.length > 0) {
                const formatTag = insertFormat !== 'folder' ? ` FORMAT=${insertFormat}` : '';
                const header = `# BATCH ${nextBatchNumber()}${formatTag}`;
                const block = header + '\n' + fresh.join('\n');
                rawList += (rawList.endsWith('\n') || rawList === '' ? '' : '\n') + block;
            }
            extractNotice = skipped > 0
                ? `Parsed ${fresh.length} link${fresh.length !== 1 ? 's' : ''} (${skipped} already in queue, skipped)`
                : `Parsed ${fresh.length} link${fresh.length !== 1 ? 's' : ''}!`;
            setTimeout(() => { extractNotice = ''; }, 3500);
        } else {
            const idMatch = newUrl.trim().match(/(\d+)/);
            if (!(idMatch && already.has(idMatch[1]))) {
                const formatTag = insertFormat !== 'folder' ? ` FORMAT=${insertFormat}` : '';
                const header = `# BATCH ${nextBatchNumber()}${formatTag}`;
                const block = header + '\n' + newUrl.trim();
                rawList += (rawList.endsWith('\n') || rawList === '' ? '' : '\n') + block;
            } else {
                extractNotice = `Already in queue, skipped`;
                setTimeout(() => { extractNotice = ''; }, 3500);
            }
        }

        newUrl = '';
        await saveList();
    }

    function removeRow(url) {
        if (confirmDelete !== url) {
            confirmDelete = url;
            setTimeout(() => { if (confirmDelete === url) confirmDelete = null; }, 3000);
            return;
        }

        const lines = rawList.split('\n');
        rawList = stripEmptyBatchHeaders(lines.filter(l => !l.includes(url)).join('\n'));
        confirmDelete = null;
        saveList();
    }

    function parseGalleryId(url) {
        const match = url.match(/\d+/);
        return match ? match[0] : 'Unknown';
    }

    let confirmClearCompleted = false;
    let clearCompletedTimeout = null;

    function clearCompleted() {
        if (!confirmClearCompleted) {
            confirmClearCompleted = true;
            clearCompletedTimeout = setTimeout(() => { confirmClearCompleted = false; }, 3500);
            return;
        }
        clearTimeout(clearCompletedTimeout);
        confirmClearCompleted = false;

        const doneIds = new Set(
            items.filter(i => i.status.includes('DONE')).map(i => parseGalleryId(i.url))
        );

        const lines = rawList.split('\n');
        const filtered = lines.filter(line => {
            if (line.trim().startsWith('#') || line.trim() === '') return true;
            const m = line.match(/(?:nhentai\.net\/g\/|^)\s*(\d+)\b/);
            return !(m && doneIds.has(m[1]));
        }).join('\n');
        rawList = stripEmptyBatchHeaders(filtered);

        saveList();
    }

    let confirmClearBatch = null;
    let clearBatchTimeout = null;

    // Removes one finished batch (its header + all its items) from the queue, once
    // everything in it is done — no need to wait and clear the whole queue at once.
    function clearBatch(num) {
        if (confirmClearBatch !== num) {
            confirmClearBatch = num;
            clearTimeout(clearBatchTimeout);
            clearBatchTimeout = setTimeout(() => { confirmClearBatch = null; }, 3000);
            return;
        }
        clearTimeout(clearBatchTimeout);
        confirmClearBatch = null;

        const lines = rawList.split('\n');
        let currentBatch = 1;
        const filtered = lines.filter(line => {
            const batchMatch = line.match(/^#\s*BATCH\s+(\d+)/i);
            if (batchMatch) {
                currentBatch = parseInt(batchMatch[1], 10);
                return currentBatch !== num;
            }
            if (line.trim().startsWith('#') || line.trim() === '') return true;
            return currentBatch !== num;
        });
        rawList = filtered.join('\n');
        saveList();
    }

    // Engine Lifecycle Controls (Start, Pause, Resume, Restart)
    async function sendControl(action) {
        try {
            const res = await fetch('/api/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });
            const data = await res.json();
            if (data.engineStatus) engineStatus = data.engineStatus;
            await fetchStatus();
        } catch(e) {
            console.error("Control action failed", e);
        }
    }

    // Force Retry Handler
    async function triggerRetry(galleryId = null) {
        try {
            retryFeedback = galleryId ? `Retrying ID ${galleryId}...` : 'Bypassing cooldown...';
            await fetch('/api/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ galleryId })
            });
            setTimeout(() => { retryFeedback = ''; }, 3000);
            await fetchStatus();
        } catch(e) {
            alert("Failed to trigger retry: " + e.message);
        }
    }

    // Directory Browser Logic (Jellyfin Style)
    async function openFolderPicker() {
        showFolderPicker = true;
        await browseDirectory(downloadDir || '');
    }

    async function browseDirectory(targetPath) {
        browseLoading = true;
        try {
            const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
            const res = await fetch(`/api/fs/browse${query}`);
            const data = await res.json();
            browsePath = data.currentPath;
            browseParent = data.parentPath;
            browseDrives = data.drives || [];
            browseDirectories = data.directories || [];
            selectedDir = data.currentPath;
        } catch(e) {
            console.error("Browse failed", e);
        } finally {
            browseLoading = false;
        }
    }

    async function saveFolderSelection() {
        if (!selectedDir) return;
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadDir: selectedDir })
            });
            const data = await res.json();
            if (data.success) {
                downloadDir = data.downloadDir;
                showFolderPicker = false;
            }
        } catch(e) {
            alert("Failed to save download folder");
        }
    }
</script>

<main class="h-screen flex flex-col bg-[#111111] text-[#e0e0e0] font-mono selection:bg-[#333] selection:text-white overflow-hidden">
    <!-- Topbar (Fixed at top) -->
    <header class="border-b border-[#222] bg-[#0a0a0a] px-6 py-3 flex items-center justify-between shrink-0 z-50">
        <div class="flex items-center space-x-3">
            <Terminal size={20} class="text-white" />
            <h1 class="text-base font-semibold tracking-tight text-white">NHDL_DAEMON</h1>
        </div>

        <div class="flex items-center space-x-3">
            <!-- Library Button (full download history, independent of the current queue) -->
            <button
                on:click={openLibrary}
                class="flex items-center space-x-2 text-xs bg-[#161616] hover:bg-[#202020] border border-[#333] hover:border-[#555] px-2.5 py-1 rounded transition-colors text-gray-300"
                title="Browse everything ever downloaded">
                <Library size={14} class="text-gray-400" />
                <span class="hidden sm:inline">Library</span>
            </button>

            <!-- Logs Button (full audit trail, viewable and downloadable) -->
            <button
                on:click={openLogs}
                class="flex items-center space-x-2 text-xs bg-[#161616] hover:bg-[#202020] border border-[#333] hover:border-[#555] px-2.5 py-1 rounded transition-colors text-gray-300"
                title="View the full activity log">
                <ScrollText size={14} class="text-gray-400" />
                <span class="hidden sm:inline">Logs</span>
            </button>

            <!-- Directory Status Badge / Button -->
            <button
                on:click={openFolderPicker}
                class="hidden sm:flex items-center space-x-2 text-xs bg-[#161616] hover:bg-[#202020] border border-[#333] hover:border-[#555] px-2.5 py-1 rounded transition-colors text-gray-300"
                title="Click to change download directory">
                <Folder size={14} class="text-gray-400" />
                <span class="max-w-[200px] md:max-w-[280px] truncate text-gray-300 font-sans">{downloadDir || 'Select Folder...'}</span>
                <span class="text-[10px] bg-[#2a2a2a] px-1.5 py-0.5 rounded text-gray-400 font-bold uppercase">Change</span>
            </button>

            {#if authRequired}
                <button
                    on:click={logout}
                    class="p-1.5 text-gray-500 hover:text-white hover:bg-[#202020] rounded transition-colors"
                    title="Log out">
                    <LogOut size={15} />
                </button>
            {/if}
        </div>
    </header>

    <!-- Main Viewport Container (Locked Height, No Window Scroll) -->
    <div class="flex-1 flex flex-col max-w-7xl mx-auto px-4 sm:px-6 py-4 w-full min-h-0 overflow-hidden space-y-4">
        
        <!-- Live Download & Cooldown Progress HUD — always mounted so it never pops in/out and
             causes a layout jump; content inside cross-fades between idle/live states instead. -->
        <div class="shrink-0 bg-[#161616] border border-[#2a2a2a] p-4 rounded-sm shadow-xl relative overflow-hidden">
            <!-- Ambient bar background -->
            <div
                class="absolute inset-0 pointer-events-none opacity-15 transition-all duration-300"
                class:bg-lime-400={!hud.idle && hud.type !== 'COOLDOWN' && hud.type !== 'BATCH_REST' && hud.type !== 'RATE_LIMIT'}
                class:bg-gray-400={hud.idle || hud.type === 'COOLDOWN' || hud.type === 'BATCH_REST'}
                class:bg-white={hud.type === 'RATE_LIMIT'}
                style="width: {hud.percent}%">
            </div>

            <!-- Control strip: engine status + Pause/Resume/Restart, always visible here
                 (next to what it controls) instead of in the header. -->
            <div class="relative z-10 flex items-center justify-between mb-3 pb-3 border-b border-[#222]">
                <div class="flex items-center space-x-2 text-xs font-semibold">
                    {#if engineStatus === 'RUNNING'}
                        <span class="w-2 h-2 rounded-full bg-lime-400 animate-pulse"></span>
                        <span class="text-lime-400">RUNNING</span>
                    {:else if engineStatus === 'PAUSED'}
                        <span class="w-2 h-2 rounded-full bg-gray-400"></span>
                        <span class="text-gray-300">PAUSED</span>
                    {:else if engineStatus.startsWith('COOLDOWN')}
                        <span class="w-2 h-2 rounded-full bg-gray-300 animate-pulse"></span>
                        <span class="text-gray-300">COOLDOWN</span>
                    {:else}
                        <span class="w-2 h-2 rounded-full bg-gray-600"></span>
                        <span class="text-gray-500">IDLE</span>
                    {/if}
                </div>

                <div class="flex items-center space-x-1.5 bg-[#0f0f0f] border border-[#2c2c2c] p-1 rounded-sm">
                    {#if engineStatus === 'RUNNING' || engineStatus === 'COOLDOWN' || engineStatus === 'COOLDOWN_429'}
                        <button
                            on:click={() => sendControl('pause')}
                            class="px-2.5 py-1 text-xs font-bold bg-white/10 hover:bg-white/15 text-gray-200 border border-white/25 rounded flex items-center space-x-1 transition-colors"
                            title="Pause / Stop downloading temporarily">
                            <Pause size={12} />
                            <span>PAUSE</span>
                        </button>
                    {:else if engineStatus === 'PAUSED'}
                        <button
                            on:click={() => sendControl('resume')}
                            class="px-2.5 py-1 text-xs font-bold bg-lime-400 text-black hover:bg-lime-300 rounded flex items-center space-x-1 transition-colors"
                            title="Resume downloading">
                            <Play size={12} />
                            <span>RESUME</span>
                        </button>
                    {:else}
                        <button
                            on:click={() => sendControl('start')}
                            class="px-2.5 py-1 text-xs font-bold bg-lime-400 text-black hover:bg-lime-300 rounded flex items-center space-x-1 transition-colors"
                            title="Start processing download queue">
                            <Play size={12} />
                            <span>START</span>
                        </button>
                    {/if}

                    <button
                        on:click={() => sendControl('restart')}
                        class="px-2 py-1 text-xs font-semibold bg-[#222] hover:bg-[#2e2e2e] text-gray-300 border border-[#383838] rounded flex items-center space-x-1 transition-colors"
                        title="Restart queue processing from scratch">
                        <RotateCcw size={12} />
                        <span>RESTART</span>
                    </button>
                </div>
            </div>

            {#key hud.idle ? 'idle' : (hud.galleryId + '-' + hud.type)}
            <div class="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4" in:fade={{ duration: 200 }}>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center space-x-2 text-xs mb-1">
                        {#if hud.idle}
                            <Moon size={14} class="text-gray-500" />
                            <span class="uppercase tracking-widest text-gray-500 font-bold">Idle — waiting for a task</span>
                        {:else if hud.type === 'COOLDOWN'}
                            <Clock size={14} class="text-gray-300 animate-spin" />
                            <span class="uppercase tracking-widest text-gray-300 font-bold">COOLDOWN (SMART DELAY) [{hud.taskNum}/{hud.totalTasks}]</span>
                        {:else if hud.type === 'BATCH_REST'}
                            <Clock size={14} class="text-gray-300" />
                            <span class="uppercase tracking-widest text-gray-300 font-bold">BATCH REST COOLDOWN [{hud.taskNum}/{hud.totalTasks}]</span>
                        {:else if hud.type === 'RATE_LIMIT'}
                            <AlertTriangle size={14} class="text-white animate-bounce" />
                            <span class="uppercase tracking-widest text-white font-bold">RATE LIMIT 429 PAUSE [{hud.taskNum}/{hud.totalTasks}]</span>
                        {:else}
                            <Activity size={14} class="text-lime-400 animate-pulse" />
                            <span class="uppercase tracking-widest text-lime-400 font-bold">DOWNLOADING [{hud.taskNum}/{hud.totalTasks}]</span>
                        {/if}
                    </div>
                    <h2 class="text-lg font-medium truncate" class:text-white={!hud.idle} class:text-gray-500={hud.idle}>{hud.title}</h2>
                    <div class="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                        {#if hud.idle}
                            <span class="text-gray-500">
                                {items.length > 0 && doneCount < items.length ? 'Press START above to start downloading the queue' : 'Add something to the queue, then press START'}
                            </span>
                        {:else if hud.message}
                            <span class="text-gray-300 font-semibold">{hud.message}</span>
                        {:else if hud.galleryId}
                            <span>ID: {hud.galleryId}</span>
                        {/if}
                        {#if hud.live === false}
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/20 text-gray-400 uppercase tracking-wide" transition:fade={{ duration: 150 }}>Last known (not running)</span>
                        {:else if hud.stalled}
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-white text-black font-bold uppercase tracking-wide animate-pulse" transition:fade={{ duration: 150 }}>Stalled {hud.stalledSeconds}s — no bytes received</span>
                        {:else if typeof hud.speedKBps === 'number' && hud.type === undefined}
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-lime-400/10 border border-lime-400/30 text-lime-400 font-bold" transition:fade={{ duration: 150 }}>{hud.speedKBps} KB/s</span>
                        {/if}
                    </div>
                </div>

                <div class="flex items-center space-x-4 shrink-0">
                    <!-- FORCE RETRY BUTTON (When Cooldown or Rate Limited) -->
                    {#if hud.type === 'COOLDOWN' || hud.type === 'RATE_LIMIT' || hud.type === 'BATCH_REST'}
                        <button
                            on:click={() => triggerRetry()}
                            transition:scale={{ duration: 150, start: 0.85 }}
                            class="bg-white hover:bg-gray-200 active:scale-95 text-black px-3 py-1.5 text-xs font-bold rounded flex items-center space-x-1.5 transition-all shadow-md shadow-black/30">
                            <RotateCcw size={13} class="animate-spin" />
                            <span>FORCE RETRY NOW</span>
                        </button>
                    {/if}

                    <div class="text-right">
                        {#if hud.idle}
                            <div class="text-2xl font-light text-gray-600">—</div>
                            <div class="text-xs text-gray-500 mt-0.5">Nothing running</div>
                        {:else if hud.type === 'COOLDOWN' || hud.type === 'BATCH_REST' || hud.type === 'RATE_LIMIT'}
                            <div class="text-2xl font-light text-white">{hud.remaining}<span class="text-sm text-gray-500 font-normal">s</span></div>
                            <div class="text-xs text-gray-400 mt-0.5">Total Cooldown: {hud.total}s</div>
                        {:else}
                            <div class="text-2xl font-light text-lime-400">{hud.percent}<span class="text-sm text-gray-500 font-normal">%</span></div>
                            <div class="text-xs text-gray-400 mt-0.5">{hud.completed} / {hud.total} Pages</div>
                        {/if}
                    </div>
                </div>
            </div>
            {/key}

            <!-- Linear Progress Bar -->
            <div class="mt-3 h-1.5 w-full bg-[#0a0a0a] rounded-full overflow-hidden">
                <div
                    class="h-full transition-all duration-300 ease-out"
                    class:bg-lime-400={!hud.idle && hud.type !== 'COOLDOWN' && hud.type !== 'BATCH_REST' && hud.type !== 'RATE_LIMIT'}
                    class:bg-gray-700={hud.idle}
                    class:bg-gray-400={!hud.idle && (hud.type === 'COOLDOWN' || hud.type === 'BATCH_REST')}
                    class:bg-white={hud.type === 'RATE_LIMIT'}
                    style="width: {hud.percent}%">
                </div>
            </div>

            <!-- Per-page active download list (shows which page/URL is downloading or retrying) -->
            {#if hud.activePages && hud.activePages.length > 0}
                <div class="mt-3 pt-3 border-t border-[#222] space-y-1" transition:slide={{ duration: 200 }}>
                    {#each hud.activePages as p (p.page)}
                        <div class="flex items-center justify-between text-[11px] gap-2" transition:fade={{ duration: 150 }} animate:flip={{ duration: 200 }}>
                            <div class="flex items-center gap-2 min-w-0 flex-1">
                                <span class="shrink-0 w-9 text-gray-500 font-bold">n{p.page}</span>
                                <span class="truncate font-sans text-gray-400" title={p.url}>{p.url}</span>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                {#if p.lastError}
                                    <span class="text-white font-semibold" title={p.lastError}>retry #{p.attempt} — {p.lastError.substring(0, 32)}</span>
                                {:else if p.totalBytes > 0}
                                    <span class="text-gray-400">{Math.round(p.bytesReceived / 1024)}/{Math.round(p.totalBytes / 1024)} KB</span>
                                    <span class="text-lime-400 w-8 text-right">{p.percent}%</span>
                                {:else}
                                    <span class="text-gray-500">connecting...</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- 2-Column Responsive Grid (Locked Height) -->
        <div class="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 overflow-hidden">
            
            <!-- Left Panel: Job Queue (ONLY THIS SCROLLS) -->
            <div class="lg:col-span-8 flex flex-col min-h-0 h-full space-y-3">
                <div class="flex flex-col border-b border-[#222] pb-2 shrink-0 space-y-1.5">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center space-x-2">
                            <h2 class="text-xs uppercase tracking-widest text-gray-400 font-bold">Execution Queue</h2>
                            {#if retryFeedback}
                                <span class="text-[11px] text-gray-300 animate-pulse font-semibold" transition:fade={{ duration: 150 }}>[{retryFeedback}]</span>
                            {/if}
                        </div>
                        <div class="flex items-center space-x-2">
                            {#if doneCount > 0}
                                <button
                                    on:click={clearCompleted}
                                    transition:fade={{ duration: 150 }}
                                    class="text-[11px] px-2 py-0.5 rounded border flex items-center gap-1 transition-colors {confirmClearCompleted ? 'bg-white text-black border-white font-bold' : 'bg-[#1a1a1a] text-gray-400 border-[#333] hover:text-white hover:border-[#555]'}">
                                    <Trash2 size={11} />
                                    {confirmClearCompleted ? `CONFIRM CLEAR ${doneCount}?` : 'Clear Completed'}
                                </button>
                            {/if}
                            <span class="text-[11px] bg-[#1a1a1a] px-2 py-0.5 rounded border border-[#333]">
                                <span class="text-lime-400 font-bold">{doneCount}</span><span class="text-gray-500"> / {items.length} Done</span>
                            </span>
                        </div>
                    </div>
                    {#if items.length > 0}
                        <div class="h-1 w-full bg-[#0a0a0a] rounded-full overflow-hidden" transition:slide={{ duration: 200 }}>
                            <div class="h-full bg-lime-400 transition-all duration-300" style="width: {(doneCount / items.length) * 100}%"></div>
                        </div>
                    {/if}
                </div>

                <!-- Independent Scroll Area for Queue Items, grouped by insert batch -->
                <div class="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar min-h-0">
                    {#if items.length === 0}
                        <div class="py-16 text-center text-gray-600 text-xs border border-dashed border-[#222] rounded-sm" transition:fade={{ duration: 200 }}>
                            NO TASKS IN QUEUE
                        </div>
                    {/if}

                    {#each batches as batch (batch.num)}
                        <div class="space-y-2" animate:flip={{ duration: 250 }}>
                            <div class="w-full flex items-center justify-between px-2.5 py-1.5 bg-[#171717] hover:bg-[#1c1c1c] border border-[#262626] rounded-sm transition-colors">
                                <button
                                    on:click={() => toggleBatch(batch.num)}
                                    class="flex items-center gap-2 flex-1 min-w-0">
                                    {#if batch.collapsed}
                                        <ChevronRight size={13} class="text-gray-500 shrink-0" />
                                    {:else}
                                        <ChevronDown size={13} class="text-gray-500 shrink-0" />
                                    {/if}
                                    <span class="text-[11px] font-bold text-gray-300 uppercase tracking-wide shrink-0">Batch {batch.num}</span>
                                    {#if batch.num === activeBatchNum}
                                        <span class="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse shrink-0"></span>
                                    {/if}
                                </button>
                                <div class="flex items-center gap-2 shrink-0">
                                    {#if batch.done === batch.total && batch.total > 0}
                                        <button
                                            on:click={() => clearBatch(batch.num)}
                                            transition:fade={{ duration: 120 }}
                                            class="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors {confirmClearBatch === batch.num ? 'bg-white text-black border-white font-bold' : 'bg-transparent text-gray-500 border-[#333] hover:text-white hover:border-[#555]'}"
                                            title="Remove this finished batch from the queue">
                                            <Trash2 size={11} />
                                            <span>{confirmClearBatch === batch.num ? 'Confirm?' : 'Clear'}</span>
                                        </button>
                                    {/if}
                                    <span class="text-[10px] text-gray-500 font-sans">{batch.done} / {batch.total} done</span>
                                </div>
                            </div>

                            {#if !batch.collapsed}
                                <div class="space-y-2 pl-2" transition:slide={{ duration: 200 }}>
                                    {#each batch.items as item (item.url)}
                                        <div
                                            class="group flex items-center justify-between bg-[#141414] border p-3 rounded-sm transition-colors {item.status.includes('DONE') ? 'border-lime-400/30 border-l-2 border-l-lime-400' : 'border-[#222] hover:border-[#383838]'}"
                                            in:fade={{ duration: 200 }}
                                            out:slide={{ duration: 200 }}
                                            animate:flip={{ duration: 250 }}>
                                            <div class="flex items-center space-x-3 overflow-hidden min-w-0 mr-2">
                                                {#if item.status.includes('DONE')}
                                                    <span class="text-[11px] px-2 py-0.5 bg-lime-400 text-black border border-lime-400 font-bold rounded-sm w-20 text-center shrink-0 flex items-center justify-center gap-1" in:scale={{ duration: 200, start: 0.8 }}>
                                                        <Check size={11} strokeWidth={3} /> DONE
                                                    </span>
                                                {:else if item.status.includes('ERROR') || item.status.includes('FAIL')}
                                                    <span class="text-[11px] px-2 py-0.5 bg-white text-black border border-white font-bold rounded-sm w-20 text-center shrink-0" in:scale={{ duration: 200, start: 0.8 }}>FAIL</span>
                                                {:else if item.status.includes('COOLDOWN')}
                                                    <span class="text-[11px] px-2 py-0.5 bg-transparent text-gray-300 border border-dashed border-gray-500 rounded-sm w-20 text-center shrink-0" in:fade={{ duration: 150 }}>PAUSED</span>
                                                {:else if item.status.includes('ON_PROGRESS')}
                                                    <span class="text-[11px] px-2 py-0.5 bg-lime-400/15 text-lime-400 border border-lime-400/40 rounded-sm w-20 text-center shrink-0 animate-pulse" in:fade={{ duration: 150 }}>ACTIVE</span>
                                                {:else if item.status.includes('SKIPPED')}
                                                    <span class="text-[11px] px-2 py-0.5 bg-gray-800/40 text-gray-500 border border-gray-700/40 rounded-sm w-20 text-center shrink-0" in:fade={{ duration: 150 }}>SKIPPED</span>
                                                {:else}
                                                    <span class="text-[11px] px-2 py-0.5 bg-[#1e1e1e] text-gray-400 border border-[#2a2a2a] rounded-sm w-20 text-center shrink-0" in:fade={{ duration: 150 }}>PENDING</span>
                                                {/if}

                                                <span class="text-xs text-gray-300 truncate font-sans" title={item.url.replace(/\+/g, ' ')}>
                                                    {(item.url.split('|')[1] ? item.url.split('|')[1].trim() : item.url).replace(/\+/g, ' ')}
                                                </span>
                                            </div>

                                            <div class="flex items-center space-x-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <!-- Force Retry button for failed/cooldown items -->
                                                {#if item.status.includes('ERROR') || item.status.includes('FAIL') || item.status.includes('COOLDOWN')}
                                                    <button
                                                        on:click={() => triggerRetry(parseGalleryId(item.url))}
                                                        transition:scale={{ duration: 150, start: 0.85 }}
                                                        class="p-1.5 text-gray-400 hover:text-white hover:bg-[#222] rounded transition-colors"
                                                        title="Force Retry this gallery immediately">
                                                        <RotateCcw size={14} />
                                                    </button>
                                                {/if}

                                                <a href="https://nhentai.net/g/{parseGalleryId(item.url)}/" target="_blank" rel="noopener noreferrer" class="p-1.5 text-gray-500 hover:text-white hover:bg-[#222] rounded transition-colors" title="Open in NHentai">
                                                    <ExternalLink size={15} />
                                                </a>

                                                <button on:click={() => removeRow(item.url)} class="p-1.5 rounded transition-colors {confirmDelete === item.url ? 'bg-white text-black border border-white' : 'text-gray-500 hover:text-white hover:bg-[#222]'}">
                                                    {#if confirmDelete === item.url}
                                                        <span class="text-[10px] font-bold px-1" transition:fade={{ duration: 120 }}>CONFIRM?</span>
                                                    {:else}
                                                        <Trash2 size={15} />
                                                    {/if}
                                                </button>
                                            </div>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>

            <!-- Right Panel: Input & Raw Config (Fixed/Sticky Area) -->
            <div class="lg:col-span-4 flex flex-col space-y-4 shrink-0 min-h-0 h-full overflow-y-auto custom-scrollbar">
                <!-- Mobile Folder Bar (shown on small screens) -->
                <div class="sm:hidden border border-[#222] bg-[#141414] p-3 rounded-sm flex items-center justify-between">
                    <div class="flex items-center space-x-2 text-xs truncate mr-2">
                        <Folder size={14} class="text-gray-400 shrink-0" />
                        <span class="truncate text-gray-400 font-sans">{downloadDir || 'Default Folder'}</span>
                    </div>
                    <button on:click={openFolderPicker} class="text-[10px] bg-[#222] hover:bg-[#333] px-2 py-1 rounded text-white font-bold shrink-0">
                        CHANGE
                    </button>
                </div>

                <!-- Add Target Box (Supports Arbitrary / Clumped Text) -->
                <div class="border border-[#222] bg-[#141414] p-3.5 rounded-sm shrink-0">
                    <div class="flex items-center justify-between mb-2">
                        <h3 class="text-[11px] uppercase tracking-widest text-gray-400 font-bold flex items-center">
                            <FileDigit size={13} class="mr-1.5" /> Insert Target
                        </h3>
                        {#if extractNotice}
                            <span class="text-[10px] bg-white/10 text-white border border-white/30 px-1.5 py-0.5 rounded animate-pulse" transition:fade={{ duration: 150 }}>
                                {extractNotice}
                            </span>
                        {/if}
                    </div>

                    <div class="space-y-2">
                        <textarea 
                            bind:value={newUrl}
                            on:keydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) appendToList(); }}
                            placeholder="Paste anything: IDs, URLs, or OneTab clumped text..."
                            rows="2"
                            class="w-full bg-[#0a0a0a] border border-[#2a2a2a] text-xs text-white p-2.5 rounded-sm focus:outline-none focus:border-white transition-colors resize-none custom-scrollbar"
                        ></textarea>
                        
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] text-gray-500">Auto-detects all links & IDs</span>
                            <div class="flex items-center gap-1.5">
                                <select
                                    bind:value={insertFormat}
                                    title="Output format for galleries added in this batch"
                                    class="bg-[#0a0a0a] border border-[#2a2a2a] text-[11px] text-gray-300 py-1.5 pl-2 pr-1 rounded-sm focus:outline-none focus:border-white transition-colors font-sans">
                                    <option value="folder">Folder</option>
                                    <option value="zip">.ZIP</option>
                                    <option value="cbz">.CBZ</option>
                                </select>
                                <button
                                    on:click={appendToList}
                                    class="bg-white text-black hover:bg-gray-200 px-4 py-1.5 text-xs font-bold rounded-sm transition-colors shrink-0">
                                    ADD TO QUEUE
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Raw List Memory Editor -->
                <div class="border border-[#222] bg-[#141414] p-3.5 rounded-sm flex flex-col flex-1 min-h-[220px]">
                    <div class="flex justify-between items-center mb-2.5 shrink-0">
                        <h3 class="text-[11px] uppercase tracking-widest text-gray-400 font-bold">Raw Memory [list.txt]</h3>
                        <button on:click={saveList} class="text-[11px] bg-[#222] hover:bg-[#2a2a2a] text-gray-300 px-2 py-1 rounded transition-colors border border-[#333]">
                            OVERWRITE
                        </button>
                    </div>
                    <textarea 
                        bind:value={rawList}
                        class="flex-1 w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-sm p-2.5 text-xs text-gray-400 focus:outline-none focus:border-gray-500 resize-none custom-scrollbar"
                        spellcheck="false"
                    ></textarea>
                </div>

                <!-- Error Logs (if any) -->
                {#if errors.trim()}
                    <div class="border border-white/20 bg-[#141414] p-3 rounded-sm shrink-0" transition:slide={{ duration: 200 }}>
                        <h3 class="text-[11px] uppercase tracking-widest text-white font-bold mb-1.5 flex items-center">
                            <AlertTriangle size={13} class="mr-1.5" /> System Faults
                        </h3>
                        <pre class="text-[10px] text-gray-300 overflow-auto max-h-28 custom-scrollbar">{errors}</pre>
                    </div>
                {/if}
            </div>

        </div>
    </div>

    <!-- JELLYFIN STYLE FOLDER PICKER MODAL -->
    {#if showFolderPicker}
        <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
            <div class="bg-[#151515] border border-[#333] rounded-md max-w-2xl w-full flex flex-col max-h-[85vh] shadow-2xl overflow-hidden" transition:scale={{ duration: 180, start: 0.95 }}>
                <!-- Modal Header -->
                <div class="border-b border-[#262626] bg-[#0d0d0d] px-5 py-3.5 flex items-center justify-between shrink-0">
                    <div class="flex items-center space-x-2">
                        <FolderOpen size={18} class="text-gray-300" />
                        <h2 class="text-sm font-semibold tracking-wider text-white uppercase">Choose Download Folder</h2>
                    </div>
                    <button on:click={() => showFolderPicker = false} class="p-1 text-gray-400 hover:text-white rounded hover:bg-[#222]">
                        <X size={18} />
                    </button>
                </div>

                <!-- Save-as Format Toggle -->
                <div class="px-5 py-2.5 bg-[#171717] border-b border-[#262626] flex items-center justify-between shrink-0">
                    <span class="text-[11px] text-gray-500 font-bold uppercase">Save galleries as:</span>
                    <div class="flex items-center bg-[#0f0f0f] border border-[#2c2c2c] p-0.5 rounded-sm">
                        <button
                            on:click={() => setDownloadFormat('folder')}
                            class="px-3 py-1 text-[11px] font-bold rounded-sm transition-colors {downloadFormat === 'folder' ? 'bg-lime-400 text-black' : 'text-gray-400 hover:text-white'}">
                            FOLDER
                        </button>
                        <button
                            on:click={() => setDownloadFormat('cbz')}
                            class="px-3 py-1 text-[11px] font-bold rounded-sm transition-colors {downloadFormat === 'cbz' ? 'bg-lime-400 text-black' : 'text-gray-400 hover:text-white'}">
                            .CBZ
                        </button>
                    </div>
                </div>

                <!-- Auto-continue Batches Toggle -->
                <div class="px-5 py-2.5 bg-[#171717] border-b border-[#262626] flex items-center justify-between shrink-0">
                    <div>
                        <span class="text-[11px] text-gray-500 font-bold uppercase block">After a batch finishes:</span>
                        <span class="text-[10px] text-gray-600">Whether newly inserted batches start automatically or wait for you to press START</span>
                    </div>
                    <div class="flex items-center bg-[#0f0f0f] border border-[#2c2c2c] p-0.5 rounded-sm shrink-0 ml-3">
                        <button
                            on:click={() => setAutoContinueBatches(true)}
                            class="px-3 py-1 text-[11px] font-bold rounded-sm transition-colors {autoContinueBatches ? 'bg-lime-400 text-black' : 'text-gray-400 hover:text-white'}">
                            AUTO
                        </button>
                        <button
                            on:click={() => setAutoContinueBatches(false)}
                            class="px-3 py-1 text-[11px] font-bold rounded-sm transition-colors {!autoContinueBatches ? 'bg-lime-400 text-black' : 'text-gray-400 hover:text-white'}">
                            WAIT
                        </button>
                    </div>
                </div>

                <!-- nhentai API Key -->
                <div class="px-5 py-2.5 bg-[#171717] border-b border-[#262626] shrink-0">
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="text-[11px] text-gray-500 font-bold uppercase">nhentai API Key (optional)</span>
                        {#if apiKeyConfigured && apiKeyStatus === 'idle'}
                            <span class="text-[10px] text-gray-600 font-mono">{apiKeyMasked}</span>
                        {/if}
                    </div>
                    <div class="flex items-center space-x-2">
                        <input
                            type="password"
                            bind:value={apiKeyInput}
                            placeholder={apiKeyConfigured ? 'Masukkan key baru untuk mengganti...' : 'Tempel API key di sini...'}
                            class="flex-1 bg-[#0f0f0f] border border-[#2c2c2c] rounded-sm px-2.5 py-1.5 text-[11px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-lime-400/50" />
                        <button
                            on:click={saveApiKey}
                            disabled={!apiKeyInput.trim() || apiKeyStatus === 'saving' || apiKeyStatus === 'checking'}
                            class="px-3 py-1.5 text-[11px] font-bold rounded-sm transition-colors bg-lime-400 text-black hover:bg-lime-300 disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
                            {apiKeyStatus === 'saving' ? 'SAVING...' : apiKeyStatus === 'checking' ? 'CHECKING...' : 'SAVE'}
                        </button>
                        {#if apiKeyConfigured}
                            <button
                                on:click={verifyApiKey}
                                disabled={apiKeyStatus === 'saving' || apiKeyStatus === 'checking'}
                                class="px-3 py-1.5 text-[11px] font-bold rounded-sm transition-colors bg-[#0f0f0f] border border-[#2c2c2c] text-gray-300 hover:text-white disabled:opacity-40 shrink-0">
                                VERIFY
                            </button>
                        {/if}
                    </div>
                    {#if apiKeyStatus === 'valid'}
                        <span class="text-[10px] text-lime-400 mt-1 block">✓ API key valid dan aktif</span>
                    {:else if apiKeyStatus === 'invalid'}
                        <span class="text-[10px] text-red-400 mt-1 block">✗ {apiKeyError}</span>
                    {:else}
                        <span class="text-[10px] text-gray-600 mt-1 block">Dipakai buat request lewat API resmi nhentai (limit lebih longgar). Disimpan di .env server, gak pernah ditampilkan utuh lagi.</span>
                    {/if}
                </div>

                <!-- Drives Selection (Windows) -->
                {#if browseDrives.length > 0}
                    <div class="px-5 py-2.5 bg-[#121212] border-b border-[#222] flex items-center space-x-2 shrink-0 overflow-x-auto custom-scrollbar" transition:slide={{ duration: 150 }}>
                        <span class="text-[11px] text-gray-500 font-bold uppercase shrink-0">Drives:</span>
                        {#each browseDrives as drive}
                            <button
                                on:click={() => browseDirectory(drive)}
                                class="flex items-center space-x-1 px-2.5 py-1 text-xs rounded border transition-colors {browsePath.startsWith(drive) ? 'bg-white/15 text-white border-white/40' : 'bg-[#1e1e1e] text-gray-300 border-[#333] hover:bg-[#282828]'}">
                                <HardDrive size={12} />
                                <span>{drive}</span>
                            </button>
                        {/each}
                    </div>
                {/if}

                <!-- Breadcrumb Path Bar -->
                <div class="px-5 py-2.5 bg-[#171717] border-b border-[#262626] flex items-center space-x-2 shrink-0">
                    {#if browseParent}
                        <button 
                            on:click={() => browseDirectory(browseParent)}
                            class="p-1.5 bg-[#222] hover:bg-[#333] text-gray-300 rounded border border-[#383838] transition-colors"
                            title="Go Up / Parent Folder">
                            <ArrowUp size={14} />
                        </button>
                    {/if}
                    <div class="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] px-3 py-1.5 text-xs text-gray-300 rounded truncate font-sans select-all">
                        {browsePath}
                    </div>
                </div>

                <!-- Directory List (Jellyfin Style Explorer) -->
                <div class="flex-1 overflow-y-auto p-3 space-y-1 bg-[#0f0f0f] min-h-[260px] custom-scrollbar">
                    {#if browseLoading}
                        <div class="py-12 text-center text-gray-500 text-xs flex flex-col items-center justify-center space-y-2" transition:fade={{ duration: 150 }}>
                            <Clock size={18} class="animate-spin text-gray-300" />
                            <span>Reading directory...</span>
                        </div>
                    {:else if browseDirectories.length === 0}
                        <div class="py-12 text-center text-gray-600 text-xs" transition:fade={{ duration: 150 }}>
                            No subfolders found in this directory.
                        </div>
                    {:else}
                        {#each browseDirectories as dir (dir.path)}
                            <button
                                on:click={() => browseDirectory(dir.path)}
                                transition:fade={{ duration: 150 }}
                                animate:flip={{ duration: 150 }}
                                class="w-full flex items-center space-x-2.5 px-3 py-2 text-left text-xs rounded transition-colors text-gray-300 hover:text-white hover:bg-[#1f1f1f] group">
                                <Folder size={15} class="text-gray-400 group-hover:text-white shrink-0" />
                                <span class="truncate font-sans font-medium">{dir.name}</span>
                            </button>
                        {/each}
                    {/if}
                </div>

                <!-- Modal Footer -->
                <div class="border-t border-[#262626] bg-[#0d0d0d] px-5 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
                    <div class="text-xs text-gray-400 truncate max-w-md w-full">
                        <span class="text-gray-500">Destination:</span> 
                        <span class="text-white font-sans ml-1 font-medium">{selectedDir}</span>
                    </div>

                    <div class="flex items-center space-x-2 w-full sm:w-auto justify-end">
                        <button 
                            on:click={() => showFolderPicker = false}
                            class="px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white bg-[#1a1a1a] hover:bg-[#252525] border border-[#333] rounded transition-colors">
                            CANCEL
                        </button>
                        <button
                            on:click={saveFolderSelection}
                            class="px-4 py-2 text-xs font-bold text-black bg-white hover:bg-gray-200 rounded transition-colors flex items-center space-x-1.5 shadow-md shadow-black/50">
                            <Check size={14} />
                            <span>SELECT THIS FOLDER</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    {/if}

    <!-- LIBRARY MODAL (full download history, independent of list.txt / current queue) -->
    {#if showLibrary}
        <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
            <div class="bg-[#151515] border border-[#333] rounded-md max-w-3xl w-full flex flex-col max-h-[85vh] shadow-2xl overflow-hidden" transition:scale={{ duration: 180, start: 0.95 }}>
                <!-- Modal Header -->
                <div class="border-b border-[#262626] bg-[#0d0d0d] px-5 py-3.5 flex items-center justify-between shrink-0">
                    <div class="flex items-center space-x-2">
                        <BookOpen size={18} class="text-gray-300" />
                        <h2 class="text-sm font-semibold tracking-wider text-white uppercase">Library</h2>
                        <span class="text-[11px] bg-[#1a1a1a] px-2 py-0.5 rounded border border-[#333] text-gray-400">{libraryTotal} total</span>
                        {#if rescanFeedback}
                            <span class="text-[11px] text-lime-400" transition:fade={{ duration: 150 }}>{rescanFeedback}</span>
                        {/if}
                    </div>
                    <div class="flex items-center space-x-2">
                        <button
                            on:click={rescanLibraryNow}
                            disabled={rescanning}
                            class="flex items-center space-x-1.5 text-[11px] px-2.5 py-1 rounded border bg-[#1a1a1a] text-gray-400 border-[#333] hover:text-white hover:border-[#555] transition-colors disabled:opacity-50"
                            title="Walk the download folder once to relink any moved/renamed gallery folders">
                            <RotateCcw size={12} class={rescanning ? 'animate-spin' : ''} />
                            <span>{rescanning ? 'Scanning...' : 'Rescan'}</span>
                        </button>
                        <button on:click={() => showLibrary = false} class="p-1 text-gray-400 hover:text-white rounded hover:bg-[#222]">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                <!-- Search Bar -->
                <div class="px-5 py-2.5 bg-[#171717] border-b border-[#262626] flex items-center space-x-2 shrink-0">
                    <Search size={14} class="text-gray-500 shrink-0" />
                    <input
                        type="text"
                        bind:value={librarySearch}
                        placeholder="Search by title, artist/group, or ID..."
                        class="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] px-3 py-1.5 text-xs text-white rounded focus:outline-none focus:border-white transition-colors font-sans" />
                    {#if librarySearch}
                        <span class="text-[11px] text-gray-500 shrink-0">{filteredLibrary.length} match{filteredLibrary.length !== 1 ? 'es' : ''}</span>
                    {/if}
                </div>

                <!-- Checklist / Batch Convert Toolbar -->
                <div class="bg-[#171717] border-b border-[#262626] shrink-0">
                    <div class="px-5 py-2 flex items-center justify-between gap-2 flex-wrap">
                        <div class="flex items-center gap-2">
                            <button on:click={selectAllVisibleLibrary} class="text-[11px] text-gray-400 hover:text-white transition-colors">Select all</button>
                            <span class="text-gray-700">/</span>
                            <button on:click={clearLibrarySelection} class="text-[11px] text-gray-400 hover:text-white transition-colors">Clear</button>
                            {#if selectedLibraryIds.size > 0}
                                <span class="text-[11px] text-gray-500" transition:fade={{ duration: 120 }}>{selectedLibraryIds.size} selected</span>
                            {/if}
                        </div>
                        <div class="flex items-center gap-2">
                            {#if batchConvertFeedback}
                                <span class="text-[11px] text-lime-400" transition:fade={{ duration: 150 }}>{batchConvertFeedback}</span>
                            {/if}
                            {#if selectedLibraryIds.size > 0 && !batchConverting}
                                <button
                                    on:click={() => batchConvertSelected('cbz')}
                                    transition:fade={{ duration: 120 }}
                                    class="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded border bg-lime-400 text-black border-lime-400 font-bold hover:bg-lime-300 transition-colors">
                                    <Archive size={12} />
                                    <span>Convert {selectedLibraryIds.size} to .CBZ</span>
                                </button>
                            {/if}
                        </div>
                    </div>

                    <!-- Live progress for the background compress job — keeps polling and
                         showing state even if this panel is reopened after being closed,
                         since the job itself lives server-side. -->
                    {#if batchConverting}
                        <div class="px-5 pb-2.5" transition:slide={{ duration: 180 }}>
                            <div class="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                                <span class="truncate mr-2">
                                    {#if compressJobProgress && compressJobProgress.currentTitle}
                                        Compressing: {compressJobProgress.currentTitle}
                                    {:else}
                                        Starting...
                                    {/if}
                                </span>
                                {#if compressJobProgress}
                                    <span class="shrink-0 text-lime-400 font-bold">{compressJobProgress.done} / {compressJobProgress.total}</span>
                                {/if}
                            </div>
                            <div class="h-1 w-full bg-[#0a0a0a] rounded-full overflow-hidden">
                                <div
                                    class="h-full bg-lime-400 transition-all duration-300"
                                    style="width: {compressJobProgress && compressJobProgress.total > 0 ? Math.round((compressJobProgress.done / compressJobProgress.total) * 100) : 0}%">
                                </div>
                            </div>
                        </div>
                    {/if}
                </div>

                <!-- Library List -->
                <div class="flex-1 overflow-y-auto p-3 space-y-1.5 bg-[#0f0f0f] min-h-[300px] custom-scrollbar">
                    {#if libraryLoading}
                        <div class="py-16 text-center text-gray-500 text-xs flex flex-col items-center justify-center space-y-2" transition:fade={{ duration: 150 }}>
                            <Clock size={18} class="animate-spin text-gray-300" />
                            <span>Loading library...</span>
                        </div>
                    {:else if filteredLibrary.length === 0}
                        <div class="py-16 text-center text-gray-600 text-xs" transition:fade={{ duration: 150 }}>
                            {librarySearch ? 'No matches found.' : 'Nothing downloaded yet.'}
                        </div>
                    {:else}
                        {#each filteredLibrary as entry (entry.id)}
                            <div
                                class="group flex items-center justify-between bg-[#141414] border border-[#222] hover:border-[#383838] p-2.5 rounded-sm transition-colors"
                                in:fade={{ duration: 150 }}
                                out:slide={{ duration: 180 }}
                                animate:flip={{ duration: 200 }}>
                                <div class="flex items-center space-x-3 overflow-hidden min-w-0 mr-2 flex-1">
                                    <button
                                        on:click={() => toggleLibrarySelect(entry.id)}
                                        class="shrink-0 text-gray-500 hover:text-white transition-colors"
                                        title="Select for batch actions">
                                        {#if selectedLibraryIds.has(entry.id)}
                                            <CheckSquare size={15} class="text-lime-400" />
                                        {:else}
                                            <Square size={15} />
                                        {/if}
                                    </button>
                                    <span class="text-[10px] px-1.5 py-0.5 bg-[#1e1e1e] text-gray-500 border border-[#2a2a2a] rounded-sm shrink-0 font-sans">{entry.pages}p</span>
                                    {#if entry.archived}
                                        <span class="text-[10px] px-1.5 py-0.5 bg-lime-400/10 text-lime-400 border border-lime-400/30 rounded-sm shrink-0 font-sans font-bold" title="Compressed to .{entry.archiveExt || 'cbz'}">{(entry.archiveExt || 'cbz').toUpperCase()}</span>
                                    {:else}
                                        <span class="text-[10px] px-1.5 py-0.5 bg-transparent text-gray-600 border border-dashed border-gray-700 rounded-sm shrink-0 font-sans" title="Still a plain folder on disk">FOLDER</span>
                                    {/if}
                                    <div class="min-w-0 flex-1">
                                        {#if renamingId === entry.id}
                                            <div class="flex items-center gap-1.5" transition:fade={{ duration: 120 }}>
                                                <input
                                                    type="text"
                                                    bind:value={renameValue}
                                                    on:keydown={(e) => { if (e.key === 'Enter') submitRename(entry.id); if (e.key === 'Escape') cancelRename(); }}
                                                    disabled={renameBusy}
                                                    class="flex-1 min-w-0 bg-[#0a0a0a] border border-white/40 text-xs text-white px-2 py-1 rounded-sm focus:outline-none font-sans"
                                                    use:focusOnMount />
                                                <button on:click={() => submitRename(entry.id)} disabled={renameBusy} class="p-1 text-lime-400 hover:bg-[#222] rounded shrink-0" title="Save">
                                                    <Check size={14} />
                                                </button>
                                                <button on:click={cancelRename} disabled={renameBusy} class="p-1 text-gray-500 hover:text-white hover:bg-[#222] rounded shrink-0" title="Cancel">
                                                    <X size={14} />
                                                </button>
                                            </div>
                                        {:else}
                                            <div class="text-xs text-gray-200 truncate font-sans">
                                                {#if entry.author}<span class="text-gray-500">{entry.author}{' - '}</span>{/if}{entry.title}
                                            </div>
                                            <div class="text-[10px] text-gray-600 font-sans flex items-center gap-2">
                                                <span>ID: {entry.id}</span>
                                                {#if entry.lang}<span>{entry.lang}</span>{/if}
                                                {#if entry.downloadedAt}<span>{new Date(entry.downloadedAt).toLocaleDateString()}</span>{/if}
                                            </div>
                                        {/if}
                                    </div>
                                </div>

                                {#if renamingId !== entry.id}
                                    <div class="flex items-center space-x-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            on:click={() => startRename(entry)}
                                            class="p-1.5 text-gray-400 hover:text-white hover:bg-[#222] rounded transition-colors"
                                            title="Rename (renames the folder/.cbz on disk too)">
                                            <Pencil size={14} />
                                        </button>
                                        {#if !entry.archived}
                                            <button
                                                on:click={() => compressEntry(entry.id)}
                                                disabled={compressingId === entry.id}
                                                class="p-1.5 text-gray-400 hover:text-white hover:bg-[#222] rounded transition-colors disabled:opacity-50"
                                                title="Compress this folder into a .cbz">
                                                <Archive size={14} class={compressingId === entry.id ? 'animate-pulse' : ''} />
                                            </button>
                                        {/if}
                                        {#if existingIds().has(entry.id)}
                                            <span class="text-[10px] text-gray-600 px-2 uppercase">In queue</span>
                                        {:else}
                                            <button
                                                on:click={() => requeueFromLibrary(entry.id)}
                                                class="p-1.5 text-gray-400 hover:text-lime-400 hover:bg-[#222] rounded transition-colors"
                                                title="Add back to queue (e.g. to re-verify files)">
                                                <RotateCcw size={14} />
                                            </button>
                                        {/if}
                                        <a href="https://nhentai.net/g/{entry.id}/" target="_blank" rel="noopener noreferrer" class="p-1.5 text-gray-500 hover:text-white hover:bg-[#222] rounded transition-colors" title="Open in NHentai">
                                            <ExternalLink size={15} />
                                        </a>
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    {/if}
                </div>
            </div>
        </div>
    {/if}

    <!-- LOGS MODAL (full audit trail — every download, control action, rename, compress,
         rescan and config change, viewable and downloadable for auditing) -->
    {#if showLogs}
        <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
            <div class="bg-[#151515] border border-[#333] rounded-md max-w-3xl w-full flex flex-col max-h-[85vh] shadow-2xl overflow-hidden" transition:scale={{ duration: 180, start: 0.95 }}>
                <div class="border-b border-[#262626] bg-[#0d0d0d] px-5 py-3.5 flex items-center justify-between shrink-0">
                    <div class="flex items-center space-x-2">
                        <ScrollText size={18} class="text-gray-300" />
                        <h2 class="text-sm font-semibold tracking-wider text-white uppercase">Activity Log</h2>
                    </div>
                    <div class="flex items-center space-x-2">
                        <button
                            on:click={downloadLogs}
                            class="flex items-center space-x-1.5 text-[11px] px-2.5 py-1 rounded border bg-[#1a1a1a] text-gray-400 border-[#333] hover:text-white hover:border-[#555] transition-colors">
                            <Download size={12} />
                            <span>Download</span>
                        </button>
                        <button on:click={() => showLogs = false} class="p-1 text-gray-400 hover:text-white rounded hover:bg-[#222]">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                <div class="flex-1 overflow-y-auto p-4 bg-[#0f0f0f] min-h-[400px] custom-scrollbar">
                    {#if logsLoading}
                        <div class="py-16 text-center text-gray-500 text-xs flex flex-col items-center justify-center space-y-2" transition:fade={{ duration: 150 }}>
                            <Clock size={18} class="animate-spin text-gray-300" />
                            <span>Loading log...</span>
                        </div>
                    {:else if !logText.trim()}
                        <div class="py-16 text-center text-gray-600 text-xs" transition:fade={{ duration: 150 }}>
                            Nothing logged yet.
                        </div>
                    {:else}
                        <pre class="text-[11px] text-gray-300 font-sans whitespace-pre-wrap break-all">{logText}</pre>
                    {/if}
                </div>
            </div>
        </div>
    {/if}
</main>

<style>
    :global(body) { 
        background-color: #111111; 
        margin: 0;
        padding: 0;
        overflow: hidden;
    }
    
    .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
    .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #262626; border-radius: 2px; }
    .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #383838; }
</style>
