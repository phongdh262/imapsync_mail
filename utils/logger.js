const fs = require('fs');
const path = require('path');

// Log directory
const LOG_DIR = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Send log message to SSE client and write to file
 * @param {string} syncId - Unique sync job ID
 * @param {object} res - Express response object (SSE)
 * @param {string} message - Log message
 * @param {boolean} isError - Is this an error message
 * @param {number} progress - Progress percentage (0-100)
 */
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

/**
 * Get log file path for a sync job
 * @param {string} syncId 
 * @returns {string} Full path to log file
 */
const getLogPath = (syncId) => path.join(LOG_DIR, `${syncId}.log`);

/**
 * Read logs from file
 * @param {string} syncId 
 * @returns {Promise<Array>} Array of log objects
 */
const readLogs = (syncId) => {
    return new Promise((resolve, reject) => {
        const logPath = getLogPath(syncId);
        if (!fs.existsSync(logPath)) {
            return resolve([]);
        }
        fs.readFile(logPath, 'utf8', (err, data) => {
            if (err) return reject(err);
            const logs = data.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try { return JSON.parse(line); } catch (e) { return null; }
                })
                .filter(l => l);
            resolve(logs);
        });
    });
};

module.exports = {
    LOG_DIR,
    sendLog,
    getLogPath,
    readLogs
};
