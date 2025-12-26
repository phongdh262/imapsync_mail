const express = require('express');
const { ImapFlow } = require('imapflow');
const pLimit = require('p-limit');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const dns = require('dns');

// Force IPv4 First (Fix for Node.js slow DNS/IPv6 fallback)
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Request Logger Middleware
app.use((req, res, next) => {
    const time = new Date().toISOString();
    console.log(`[REQ ${time}] ${req.method} ${req.url}`);
    next();
});
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'templates')));

// Ensure logs directory exists
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Active jobs store: syncId -> { controller: AbortController }
const activeJobs = new Map();

// Global Stats (In-memory)
let serverStats = {
    totalEmails: 0,
    totalBytes: 0
};

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
        // Force close connections immediately
        if (job.clients) {
            job.clients.forEach(c => { try { c.close(); } catch (e) { } });
        }
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

// Route: Get Stats
app.get('/api/stats', (req, res) => {
    res.json(serverStats);
});

// Route: Reset Stats
app.post('/api/stats/reset', (req, res) => {
    serverStats = { totalEmails: 0, totalBytes: 0 };
    res.json({ success: true });
});

// Route: Test Connection
app.post('/api/test-connection', async (req, res) => {
    const { host, port, user, pass, secure } = req.body;

    // Safety check
    if (!host || !user || !pass) {
        return res.json({ success: false, error: "Missing Host, User or Password" });
    }

    const client = new ImapFlow({
        host: host,
        port: parseInt(port) || 993,
        secure: secure === true, // Explicit bool
        auth: { user, pass },
        logger: false,
        tls: { rejectUnauthorized: false },
        emitLogs: false
    });

    try {
        await client.connect();
        await client.logout();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message || "Connection failed" });
    } finally {
        // Ensure closed
        client.close();
    }
});

// Route: Start Sync (Optimized: Parallel Connect + Merged Scan/Sync)
app.post('/api/sync', async (req, res) => {
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
    const createClient = (host, port, user, pass, secure, desc) => new ImapFlow({
        host,
        port: parseInt(port) || 993,
        secure,
        auth: { user, pass },
        logger: false, // Too verbose
        tls: { rejectUnauthorized: false },
        emitLogs: false,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 60000
    });

    let clientSrc = createClient(src_host, src_port, src_user, src_pass, isSrcSecure, "Source");
    clients.push(clientSrc);

    let clientDest = null;
    if (!isDryRun) {
        clientDest = createClient(dest_host, dest_port, dest_user, dest_pass, isDestSecure, "Dest");
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
            // We keep srcLock open to read bodies safely
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
                            serverStats.totalEmails++;
                            serverStats.totalBytes += msg.source.length;
                        }

                        // 3. Log
                        totalProcessed++;
                        // Use a rolling counter for progress since we don't have grand total
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

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
