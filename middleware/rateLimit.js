/**
 * Simple in-memory rate limiter
 * Limits requests per IP address
 */

// Store for tracking requests: { ip: { count, resetTime } }
const requestCounts = new Map();

// Configuration
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS = 100; // Max 100 requests per window

/**
 * Rate limiting middleware
 */
const rateLimiter = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    // Get or create entry for this IP
    let entry = requestCounts.get(ip);

    if (!entry || now > entry.resetTime) {
        // New window
        entry = {
            count: 1,
            resetTime: now + WINDOW_MS
        };
        requestCounts.set(ip, entry);
    } else {
        // Existing window, increment count
        entry.count++;
    }

    // Check if over limit
    if (entry.count > MAX_REQUESTS) {
        const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({
            error: 'Too many requests',
            message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
            retryAfter
        });
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', MAX_REQUESTS - entry.count);
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    next();
};

/**
 * Cleanup old entries periodically (every 5 minutes)
 */
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of requestCounts) {
        if (now > entry.resetTime) {
            requestCounts.delete(ip);
        }
    }
}, 5 * 60 * 1000);

module.exports = rateLimiter;
