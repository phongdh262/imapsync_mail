const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./logger');

// Log retention in days
const LOG_RETENTION_DAYS = 7;

/**
 * Delete log files older than retention period
 * @returns {Promise<{deleted: number, errors: number}>}
 */
const cleanupOldLogs = async () => {
    const now = Date.now();
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000; // 7 days in ms

    let deleted = 0;
    let errors = 0;

    try {
        if (!fs.existsSync(LOG_DIR)) {
            return { deleted: 0, errors: 0 };
        }

        const files = fs.readdirSync(LOG_DIR);

        for (const file of files) {
            if (!file.endsWith('.log')) continue;

            const filePath = path.join(LOG_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                const age = now - stat.mtimeMs;

                if (age > maxAge) {
                    fs.unlinkSync(filePath);
                    deleted++;
                    console.log(`[Cleanup] Deleted old log: ${file}`);
                }
            } catch (err) {
                errors++;
                console.error(`[Cleanup] Error processing ${file}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[Cleanup] Error reading log directory:', err.message);
        errors++;
    }

    return { deleted, errors };
};

/**
 * Schedule daily cleanup (runs at startup + every 24 hours)
 */
const scheduleCleanup = () => {
    // Run immediately on startup
    cleanupOldLogs().then(result => {
        console.log(`[Cleanup] Startup cleanup: ${result.deleted} files deleted`);
    });

    // Schedule daily cleanup (every 24 hours)
    setInterval(() => {
        cleanupOldLogs().then(result => {
            if (result.deleted > 0) {
                console.log(`[Cleanup] Daily cleanup: ${result.deleted} files deleted`);
            }
        });
    }, 24 * 60 * 60 * 1000);
};

module.exports = {
    cleanupOldLogs,
    scheduleCleanup,
    LOG_RETENTION_DAYS
};
