const express = require('express');
const { ImapFlow } = require('imapflow');
const pLimit = require('p-limit');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'templates')));

// Ensure logs directory exists
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Active jobs store: syncId -> { controller: AbortController }
const activeJobs = new Map();

// Helper to format logs for SSE and File
const sendLog = (syncId, res, message, isError = false, progress = undefined) => {
    const timestamp = new Date().toISOString();
    const logObj = { timestamp, message, is_error: isError, progress };

    // 1. Write to File
    if (syncId) {
        fs.appendFile(path.join(LOG_DIR, `${syncId}.log`), JSON.stringify(logObj) + '\n', (err) => {
            if (err) console.error("Log write error:", err);
        });
    }

    // 2. Send to Client (SSE)
    if (res && !res.writableEnded) {
        const data = JSON.stringify({ message, is_error: isError, progress });
        try {
            res.write(`data: ${data}\n\n`);
        } catch (e) {
            console.error("SSE Write Error:", e.message);
        }
    }
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
        // Log the stop event to file
        const logPath = path.join(LOG_DIR, `${sync_id}.log`);
        if (fs.existsSync(logPath)) {
            fs.appendFile(logPath, JSON.stringify({ timestamp: new Date().toISOString(), message: "Stopped by user.", is_error: true }) + '\n', () => { });
        }
    }
    res.json({ status: 'success' });
});

// Route: Get Job Status (For recovering session)
app.get('/api/status/:sync_id', (req, res) => {
    const { sync_id } = req.params;
    const isActive = activeJobs.has(sync_id);
    const logPath = path.join(LOG_DIR, `${sync_id}.log`);

    if (!fs.existsSync(logPath) && !isActive) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
        status: isActive ? 'running' : 'stopped', // simplified status
        active: isActive
    });
});

// Route: Get Full Logs (For restoring UI)
app.get('/api/logs/:sync_id', (req, res) => {
    const { sync_id } = req.params;
    const logPath = path.join(LOG_DIR, `${sync_id}.log`);

    if (fs.existsSync(logPath)) {
        fs.readFile(logPath, 'utf8', (err, data) => {
            if (err) return res.status(500).json({ error: 'Read error' });
            // Parse line by line
            const logs = data.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try { return JSON.parse(line); } catch (e) { return null; }
                })
                .filter(l => l);
            res.json(logs);
        });
    } else {
        res.status(404).json({ error: 'Logs not found' });
    }
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
        sendLog(sync_id, res, "Connecting to source...", false, 0);
        await clientSrc.connect();

        if (!dry_run) {
            sendLog(sync_id, res, "Connecting to destination...");
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
            sendLog(sync_id, res, "No folders found to sync.", false, 100);
            return; // End
        }

        let totalEmails = 0;
        const jobQueue = [];

        // 2. Scan Folders & Build Queues
        sendLog(sync_id, res, `Scanning ${targetFolders.length} folders...`);

        for (const folder of targetFolders) {
            if (signal.aborted) break;

            try {
                const lock = await clientSrc.getMailboxLock(folder);
                try {
                    const searchCriteria = since_date ? { since: new Date(since_date) } : { all: true };
                    const status = await clientSrc.status(folder, { messages: true });

                    for await (const msg of clientSrc.fetch(searchCriteria, { uid: true })) {
                        jobQueue.push({ folder, uid: msg.uid });
                    }

                    sendLog(sync_id, res, `Folder ${folder}: Found items matching criteria.`);
                } catch (err) {
                    sendLog(sync_id, res, `Skip folder ${folder}: ${err.message}`, true);
                } finally {
                    lock.release();
                }
            } catch (err) {
                sendLog(sync_id, res, `Error accessing ${folder}: ${err.message}`, true);
            }
        }

        totalEmails = jobQueue.length;
        if (totalEmails === 0) {
            sendLog(sync_id, res, "No emails found matching criteria.", false, 100);
        } else {
            sendLog(sync_id, res, `Total ${totalEmails} emails to sync. Starting...`);

            // 3. Process Queue
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
                let srcLock;
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
                            const msg = await clientSrc.fetchOne(uid, { source: true });
                            const raw = msg.source;

                            if (!dry_run) {
                                await clientDest.append(folder, raw);
                            }

                            processedCount++;
                            const progress = Math.round((processedCount / totalEmails) * 100);
                            sendLog(sync_id, res, `Synced ${folder}:${uid}`, false, progress);

                        } catch (err) {
                            sendLog(sync_id, res, `Err ${folder}:${uid} - ${err.message}`, true);
                        }
                    }));

                    await Promise.all(promises);

                } catch (err) {
                    sendLog(sync_id, res, `Error processing folder ${folder}: ${err.message}`, true);
                } finally {
                    if (srcLock) srcLock.release();
                }
            }
        }

        if (!signal.aborted) {
            sendLog(sync_id, res, "Sync completed!", false, 100);
        }

    } catch (err) {
        if (signal.aborted || err.message === 'Stopped by user.') {
            sendLog(sync_id, res, "Stopped by user.", true);
        } else {
            sendLog(sync_id, res, `Critical Error: ${err.message}`, true);
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
