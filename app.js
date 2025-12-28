const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const dns = require('dns');

// Force IPv4 First (Fix for Node.js slow DNS/IPv6 fallback)
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

// Import routes and middleware
const { router: apiRouter } = require('./routes/api');
const syncRouter = require('./routes/sync');
const rateLimiter = require('./middleware/rateLimit');
const { scheduleCleanup } = require('./utils/cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());

// Request Logger
app.use((req, res, next) => {
    const time = new Date().toISOString();
    console.log(`[REQ ${time}] ${req.method} ${req.url}`);
    next();
});

app.use(bodyParser.json());

// Rate Limiting (apply to API routes)
app.use('/api', rateLimiter);

// Static files
app.use(express.static(path.join(__dirname, 'public')));
// Legacy support: also serve from templates folder
app.use(express.static(path.join(__dirname, 'templates')));

// ============================================
// ROUTES
// ============================================

// Serve Frontend
app.get('/', (req, res) => {
    // Try public folder first, fallback to templates
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const templatesPath = path.join(__dirname, 'templates', 'index.html');

    const fs = require('fs');
    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else {
        res.sendFile(templatesPath);
    }
});

// API Routes
app.use('/api', apiRouter);
app.use('/api', syncRouter);

// ============================================
// STARTUP
// ============================================

// Schedule log cleanup (runs at startup + daily)
scheduleCleanup();

app.listen(PORT, () => {
    console.log(`╔════════════════════════════════════════════╗`);
    console.log(`║   IMAP Sync Pro Server                     ║`);
    console.log(`║   Running at http://localhost:${PORT}          ║`);
    console.log(`╚════════════════════════════════════════════╝`);
});
