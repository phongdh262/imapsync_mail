const express = require('express');
const router = express.Router();
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { LOG_DIR, readLogs, getLogPath } = require('../utils/logger');

// Global Stats (In-memory)
let serverStats = {
    totalEmails: 0,
    totalBytes: 0
};

// Active jobs store (shared with sync routes)
const activeJobs = new Map();

/**
 * GET /api/stats - Get server statistics
 */
router.get('/stats', (req, res) => {
    res.json(serverStats);
});

/**
 * POST /api/stats/reset - Reset server statistics
 */
router.post('/stats/reset', (req, res) => {
    serverStats = { totalEmails: 0, totalBytes: 0 };
    res.json({ success: true });
});

/**
 * GET /api/status/:sync_id - Get job status
 */
router.get('/status/:sync_id', (req, res) => {
    const { sync_id } = req.params;
    const isActive = activeJobs.has(sync_id);
    const logPath = getLogPath(sync_id);

    if (!fs.existsSync(logPath) && !isActive) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
        status: isActive ? 'running' : 'stopped',
        active: isActive
    });
});

/**
 * GET /api/logs/:sync_id - Get job logs
 */
router.get('/logs/:sync_id', async (req, res) => {
    const { sync_id } = req.params;

    try {
        const logs = await readLogs(sync_id);
        if (logs.length === 0 && !fs.existsSync(getLogPath(sync_id))) {
            return res.status(404).json({ error: 'Logs not found' });
        }
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: 'Read error' });
    }
});

/**
 * POST /api/test-connection - Test IMAP connection
 */
router.post('/test-connection', async (req, res) => {
    const { host, port, user, pass, secure } = req.body;

    // Validation
    if (!host || !user || !pass) {
        return res.json({ success: false, error: "Missing Host, User or Password" });
    }

    const client = new ImapFlow({
        host: host,
        port: parseInt(port) || 993,
        secure: secure === true,
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
        client.close();
    }
});

// Export router and shared state
module.exports = {
    router,
    activeJobs,
    serverStats,
    updateStats: (emails, bytes) => {
        serverStats.totalEmails += emails;
        serverStats.totalBytes += bytes;
    }
};
