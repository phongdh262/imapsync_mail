const express = require('express');
const { ImapFlow } = require('imapflow');
const pLimit = require('p-limit');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'templates')));

// Active jobs store: syncId -> { controller: AbortController }
const activeJobs = new Map();

// Helper to format logs for SSE
const sendLog = (res, message, isError = false, progress = undefined) => {
    const data = JSON.stringify({ message, is_error: isError, progress });
    res.write(`data: ${data}\n\n`);
};

// Route: Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// Route: Stop Sync
app.post('/api/stop', (req, res) => {
    const { sync_id } = req.body;
    if (activeJobs.has(sync_id)) {
        const job = activeJobs.get(sync_id);
        job.controller.abort();
        activeJobs.delete(sync_id);
        console.log(`Job ${sync_id} stopped by user.`);
    }
    res.json({ status: 'success' });
});

// Route: Start Sync
app.post('/api/sync', async (req, res) => {
    const {
        sync_id,
        src_host, src_port, src_user, src_pass,
        dest_host, dest_port, dest_user, dest_pass,
        concurrency = 1,
        dry_run = false,
        since_date = '',
        exclude_folders = ''
    } = req.body;

    // SSE Setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for Nginx/Proxies

    const controller = new AbortController();
    const signal = controller.signal;
    activeJobs.set(sync_id, { controller });

    const clientSrc = new ImapFlow({
        host: src_host,
        port: parseInt(src_port) || 993,
        secure: true,
        auth: { user: src_user, pass: src_pass },
        logger: false,
        tls: { rejectUnauthorized: false } // Accept self-signed certs
    });

    let clientDest = null;
    if (!dry_run) {
        clientDest = new ImapFlow({
            host: dest_host,
            port: parseInt(dest_port) || 993,
            secure: true,
            auth: { user: dest_user, pass: dest_pass },
            logger: false,
            tls: { rejectUnauthorized: false }
        });
    }

    try {
        sendLog(res, "Connecting to source...", false, 0);
        await clientSrc.connect();

        if (!dry_run) {
            sendLog(res, "Connecting to destination...");
            await clientDest.connect();
        }

        if (signal.aborted) throw new Error("Stopped by user.");

        // 1. List Folders
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
            sendLog(res, "No folders found to sync.", false, 100);
            return; // End
        }

        let totalEmails = 0;
        const jobQueue = [];

        // 2. Scan Folders & Build Queues
        sendLog(res, `Scanning ${targetFolders.length} folders...`);

        for (const folder of targetFolders) {
            if (signal.aborted) break;

            try {
                const lock = await clientSrc.getMailboxLock(folder);
                try {
                    const searchCriteria = since_date ? { since: new Date(since_date) } : { all: true };
                    // imap-flow fetch returns async generator or we can use fetchOne
                    // We just want IDs first or iterate directly.
                    // Let's use fetch directly to get UIDs.

                    // Note: imap-flow doesn't have a simple 'search' returning IDs Array like python imaplib.
                    // We iterate fetch. 
                    // Actually, let's fetch headers/uid only to build the list -> Safer for progress.

                    // HOWEVER, for performance on huge folders, streaming is better.
                    // But to show "Total X emails", we need a count first using status or search.

                    const status = await clientSrc.status(folder, { messages: true });
                    // We can't easily filter by date with STATUS. 
                    // Let's iterate fetch with filtering.

                    // To be efficient, we'll push "tasks" to the queue. 
                    // A task is (folder, uid).

                    // Use fetch to get UIDs matching criteria
                    for await (const msg of clientSrc.fetch(searchCriteria, { uid: true })) {
                        jobQueue.push({ folder, uid: msg.uid });
                    }

                    sendLog(res, `Folder ${folder}: Found items matching criteria.`);
                } catch (err) {
                    sendLog(res, `Skip folder ${folder}: ${err.message}`, true);
                } finally {
                    lock.release();
                }
            } catch (err) {
                sendLog(res, `Error accessing ${folder}: ${err.message}`, true);
            }
        }

        totalEmails = jobQueue.length;
        if (totalEmails === 0) {
            sendLog(res, "No emails found matching criteria.", false, 100);
        } else {
            sendLog(res, `Total ${totalEmails} emails to sync. Starting...`);

            // 3. Process Queue
            // We need to manage connections. imap-flow isn't really multi-thread safe on SAME connection for selecting different folders violently.
            // Best global strategy: Group by folder to minimize SELECT churn, OR use concurrency carefully.
            // Appending to dest can be concurrent if dest supports it (most do).
            // Catch: Reading from SRC requires SELECT. If we have parallel reads on different folders, we need multiple connections.
            // ImapFlow is single-connection. 'lock' prevents race conditions but blocks.

            // OPTIMIZATION: Process one folder at a time, but read/write messages in parallel WITHIN that folder.

            // Let's regroup the queue by folder
            const tasksByFolder = {};
            for (const t of jobQueue) {
                if (!tasksByFolder[t.folder]) tasksByFolder[t.folder] = [];
                tasksByFolder[t.folder].push(t.uid);
            }

            const limit = pLimit(parseInt(concurrency) || 1);
            let processedCount = 0;

            for (const folder of Object.keys(tasksByFolder)) {
                if (signal.aborted) break;

                const uids = tasksByFolder[folder];

                // Lock Source Folder
                let srcLock, destLock;
                try {
                    srcLock = await clientSrc.getMailboxLock(folder);

                    // Ensure Dest Folder Exists (if not dry run)
                    if (!dry_run) {
                        try {
                            await clientDest.mailboxOpen(folder); // Checks existence/selects
                        } catch (e) {
                            try {
                                await clientDest.mailboxCreate(folder);
                                await clientDest.mailboxOpen(folder);
                            } catch (e2) {
                                // Fallback to INBOX if cant create
                                await clientDest.mailboxOpen('INBOX');
                            }
                        }
                    }

                    // Process UIDs in this folder
                    const promises = uids.map(uid => limit(async () => {
                        if (signal.aborted) return;

                        try {
                            // Fetch Message Source
                            // fetchOne is convenient
                            const msg = await clientSrc.fetchOne(uid, { source: true });
                            const raw = msg.source;

                            if (dry_run) {
                                // Simulate
                            } else {
                                // Append to Dest
                                // append(path, content, flags, date)
                                await clientDest.append(folder, raw);
                            }

                            processedCount++;
                            const progress = Math.round((processedCount / totalEmails) * 100);
                            sendLog(res, `Synced ${folder}:${uid}`, false, progress);

                        } catch (err) {
                            sendLog(res, `Err ${folder}:${uid} - ${err.message}`, true);
                        }
                    }));

                    await Promise.all(promises);

                } catch (err) {
                    sendLog(res, `Error processing folder ${folder}: ${err.message}`, true);
                } finally {
                    if (srcLock) srcLock.release();
                }
            }
        }

        if (!signal.aborted) {
            sendLog(res, "Sync completed!", false, 100);
        }

    } catch (err) {
        if (signal.aborted || err.message === 'Stopped by user.') {
            sendLog(res, "Stopped by user.", true);
        } else {
            sendLog(res, `Critical Error: ${err.message}`, true);
        }
    } finally {
        // Cleanup
        if (clientSrc) await clientSrc.logout();
        if (clientDest) await clientDest.logout();
        activeJobs.delete(sync_id);
        res.end();
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
