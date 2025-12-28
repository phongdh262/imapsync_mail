const express = require('express');
const router = express.Router();
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const pLimit = require('p-limit');
const { sendLog, LOG_DIR, getLogPath } = require('../utils/logger');
const { activeJobs, updateStats } = require('./api');

/**
 * POST /api/stop - Stop a running sync job
 */
router.post('/stop', (req, res) => {
    const { sync_id } = req.body;
    if (activeJobs.has(sync_id)) {
        const job = activeJobs.get(sync_id);
        job.controller.abort();
        // Force close connections immediately
        if (job.clients) {
            job.clients.forEach(c => { try { c.close(); } catch (e) { } });
        }
        activeJobs.delete(sync_id);
        console.log(`Job ${sync_id} stopped by user.`);
        // Log the stop event to file
        const logPath = getLogPath(sync_id);
        if (fs.existsSync(logPath)) {
            fs.appendFile(logPath, JSON.stringify({ timestamp: new Date().toISOString(), message: "Stopped by user.", is_error: true }) + '\n', () => { });
        }
    }
    res.json({ status: 'success' });
});

/**
 * POST /api/sync - Start sync process (SSE)
 */
router.post('/sync', async (req, res) => {
    const {
        sync_id,
        src_host, src_port, src_user, src_pass, src_secure,
        dest_host, dest_port, dest_user, dest_pass, dest_secure,
        concurrency = 1,
        dry_run = false,
        since_date = '',
        exclude_folders = ''
    } = req.body;

    // Safe Boolean Parsing
    const isSrcSecure = String(src_secure) === 'true' || src_secure === true;
    const isDestSecure = String(dest_secure) === 'true' || dest_secure === true;
    const isDryRun = String(dry_run) === 'true' || dry_run === true;

    console.log(`[SYNC-REQ] ID:${sync_id} Src:${src_host} Dest:${dest_host} DryRun:${isDryRun}`);

    // SSE Setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const controller = new AbortController();
    const signal = controller.signal;
    const clients = [];
    activeJobs.set(sync_id, { controller, clients });

    // Client Config
    const createClient = (host, port, user, pass, secure) => new ImapFlow({
        host,
        port: parseInt(port) || 993,
        secure,
        auth: { user, pass },
        logger: false,
        tls: { rejectUnauthorized: false },
        emitLogs: false,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 60000
    });

    let clientSrc = createClient(src_host, src_port, src_user, src_pass, isSrcSecure);
    clients.push(clientSrc);

    let clientDest = null;
    if (!isDryRun) {
        clientDest = createClient(dest_host, dest_port, dest_user, dest_pass, isDestSecure);
        clients.push(clientDest);
    }

    // Helper: Timeout Wrapper
    const withTimeout = (promise, ms, name) => {
        let timer;
        return new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${name} Connection timed out`)), ms);
            if (signal.aborted) { clearTimeout(timer); return reject(new Error("Stopped by user.")); }

            promise.then(res => { clearTimeout(timer); resolve(res); })
                .catch(err => { clearTimeout(timer); reject(err); });
        });
    };

    try {
        if (signal.aborted) throw new Error("Stopped by user.");

        // 1. Sequential Connection (Source first, then Destination)
        sendLog(sync_id, res, "Connecting to Source...", false, 0);
        await withTimeout(clientSrc.connect(), 45000, "Source");
        sendLog(sync_id, res, "Connected to Source.");

        if (clientDest) {
            sendLog(sync_id, res, "Connecting to Destination...");
            await withTimeout(clientDest.connect(), 45000, "Destination");
            sendLog(sync_id, res, "Connected to Destination.");
        }

        if (signal.aborted) throw new Error("Stopped by user.");

        // 2. Prepare Folders
        const folders = await clientSrc.list();
        const excludeList = exclude_folders.split(',').map(f => f.trim()).filter(f => f);

        let targetFolders = [];
        for (const f of folders) {
            const name = f.path;
            const shortName = name.split('/').pop();
            if (!excludeList.includes(name) && !excludeList.includes(shortName)) {
                targetFolders.push(name);
            }
        }

        if (targetFolders.length === 0) {
            sendLog(sync_id, res, "No folders found to sync.", false, 100);
            return;
        }

        sendLog(sync_id, res, `Found ${targetFolders.length} folders: ${targetFolders.map(f => f.split('/').pop()).join(', ')}`);

        // --- SMART MAP PRE-CHECK (Only if dest connected) ---
        let mapObj = req.body.folder_mapping || {};
        if (req.body.smart_map && !isDryRun) {
            sendLog(sync_id, res, "Auto-detecting Smart Map...");
            const destList = await clientDest.list();
            const destNames = destList.map(f => f.path);

            const SPECIAL = {
                'Sent': ['Sent', 'Sent Items', 'Sent Messages', '[Gmail]/Sent Mail', 'Sent Mail'],
                'Trash': ['Trash', 'Deleted Items', 'Bin', '[Gmail]/Trash'],
                'Drafts': ['Drafts', '[Gmail]/Drafts'],
                'Spam': ['Junk', 'Spam', '[Gmail]/Spam', 'Bulk Mail']
            };

            const findMatch = (list, patterns) => {
                for (const p of patterns) {
                    const m = list.find(f => f.toLowerCase() === p.toLowerCase() || f.endsWith('/' + p));
                    if (m) return m;
                }
                return null;
            };

            for (const [type, pats] of Object.entries(SPECIAL)) {
                const srcMatch = findMatch(targetFolders, pats);
                const destMatch = findMatch(destNames, pats);
                if (srcMatch && destMatch && srcMatch !== destMatch && !mapObj[srcMatch]) {
                    mapObj[srcMatch] = destMatch;
                    sendLog(sync_id, res, `[Smart Map] "${srcMatch}" -> "${destMatch}"`);
                }
            }
        }

        // 3. Merged Scan & Sync Loop
        sendLog(sync_id, res, `Starting Sync for ${targetFolders.length} folders...`);
        let totalProcessed = 0;

        // Concurrency Limiter
        const limit = pLimit(parseInt(concurrency) || 1);

        for (const folder of targetFolders) {
            if (signal.aborted) break;

            const destFolder = mapObj[folder] || folder; // Map or keep original

            // --- A. Scan Source ---
            let uids = [];
            let srcLock;
            try {
                sendLog(sync_id, res, `Scanning ${folder}...`);
                srcLock = await clientSrc.getMailboxLock(folder);

                const criteria = since_date ? { since: new Date(since_date) } : { all: true };
                // Fetch ALL UIDs first (fast)
                for await (const msg of clientSrc.fetch(criteria, { uid: true })) {
                    uids.push(msg.uid);
                }
            } catch (scanErr) {
                sendLog(sync_id, res, `Skip ${folder} (Access Denied)`, true);
                if (srcLock) srcLock.release();
                continue; // Skip this folder
            }

            if (uids.length === 0) {
                sendLog(sync_id, res, `Folder ${folder}: Empty (0 items).`);
                srcLock.release();
                continue;
            }

            sendLog(sync_id, res, `Processing ${folder}: ${uids.length} emails found.`);

            // --- B. Prepare Dest (If needed) ---
            if (!isDryRun) {
                try {
                    await clientDest.mailboxOpen(destFolder);
                } catch (e) {
                    try {
                        await clientDest.mailboxCreate(destFolder);
                        await clientDest.mailboxOpen(destFolder);
                    } catch (e2) {
                        try { await clientDest.mailboxOpen('INBOX'); } catch (e3) { } // Safety net
                    }
                }
            }

            // --- C. Sync Loop (Batched by Concurrency) ---
            try {
                const folderPromises = uids.map(uid => limit(async () => {
                    if (signal.aborted) return;
                    try {
                        // 1. Fetch Body
                        const msg = await clientSrc.fetchOne(uid, { source: true });
                        if (!msg || !msg.source) return;

                        // 2. Append to Dest
                        if (!isDryRun) {
                            await clientDest.append(destFolder, msg.source);
                            updateStats(1, msg.source.length);
                        }

                        // 3. Log
                        totalProcessed++;
                        sendLog(sync_id, res, `Synced ${folder}:${uid} -> ${destFolder}`, false);

                    } catch (itemErr) {
                        sendLog(sync_id, res, `Err ${folder}:${uid} - ${itemErr.message}`, true);
                    }
                }));

                await Promise.all(folderPromises);

            } finally {
                srcLock.release(); // Important: Release lock after processing folder
            }
        }

        if (!signal.aborted) {
            sendLog(sync_id, res, "Sync completed!", false, 100);
        }

    } catch (err) {
        if (signal.aborted || err.message.includes('Stopped')) {
            sendLog(sync_id, res, "Stopped by user.", true);
        } else {
            sendLog(sync_id, res, `Critical Error: ${err.message}`, true);
        }
    } finally {
        if (clientSrc) try { await clientSrc.logout(); } catch (e) { }
        if (clientDest) try { await clientDest.logout(); } catch (e) { }
        activeJobs.delete(sync_id);
        res.end();
    }
});

module.exports = router;
