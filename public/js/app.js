/**
 * IMAP Sync Pro - Core Application Module
 * Handles utilities, tabs, stats, and initialization
 */

// ============================================
// UTILITIES
// ============================================
const generateUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

function formatIMAPDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function togglePort(type) {
    const secure = document.getElementById(type + '_secure').checked;
    document.getElementById(type + '_port').value = secure ? 993 : 143;
}

// ============================================
// TAB NAVIGATION
// ============================================
function switchTab(tab) {
    // Hide all first
    ['input-single', 'input-bulk', 'output-single', 'output-bulk'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
    });

    const sBtn = document.getElementById('tab-single');
    const bBtn = document.getElementById('tab-bulk');

    const activeClass = "px-6 py-2.5 rounded-lg text-sm font-bold transition-all duration-300 shadow-md bg-blue-600 text-white shadow-blue-900/20";
    const inactiveClass = "px-6 py-2.5 rounded-lg text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-700 transition-all duration-300";

    if (tab === 'single') {
        document.getElementById('input-single').classList.remove('hidden');
        document.getElementById('output-single').classList.remove('hidden');
        sBtn.className = activeClass;
        bBtn.className = inactiveClass;
    } else {
        document.getElementById('input-bulk').classList.remove('hidden');
        document.getElementById('output-bulk').classList.remove('hidden');
        bBtn.className = activeClass;
        sBtn.className = inactiveClass;
    }
}

// ============================================
// CSV FILE UPLOAD
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const csvFileInput = document.getElementById('csvFile');
    if (csvFileInput) {
        csvFileInput.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function (e) { document.getElementById('bulkInput').value = e.target.result; };
            reader.readAsText(file);
        });
    }

    // Initialize concurrency slider
    const concurrencyInput = document.getElementById('concurrency');
    if (concurrencyInput) {
        concurrencyInput.addEventListener('input', (e) => {
            document.getElementById('concurrencyVal').textContent = `${e.target.value} Thread${e.target.value > 1 ? 's' : ''}`;
        });
    }

    // Start session restore
    restoreSession();
});

// ============================================
// STATS POLLING
// ============================================
setInterval(async () => {
    try {
        const res = await fetch('/api/stats');
        const stats = await res.json();
        document.getElementById('stat_emails').textContent = stats.totalEmails.toLocaleString();
        document.getElementById('stat_bytes').textContent = formatBytes(stats.totalBytes);

        // Check for failures to show Retry button (bulk mode)
        if (typeof bulkJobs !== 'undefined') {
            const hasFailed = bulkJobs.some(j => j.status === 'Error');
            const retryBtn = document.getElementById('btnRetryFailed');
            if (retryBtn) {
                if (hasFailed && !isBatchRunning) {
                    retryBtn.classList.remove('hidden');
                } else {
                    retryBtn.classList.add('hidden');
                }
            }
        }
    } catch (e) { }
}, 3000);

async function resetStats() {
    const ok = await showConfirm("Reset Statistics?", "Are you sure you want to reset all migration statistics?");
    if (!ok) return;

    try {
        const res = await fetch('/api/stats/reset', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showInfo("Stats Reset", "Migration statistics have been reset.", false);
            document.getElementById('stat_emails').textContent = '0';
            document.getElementById('stat_bytes').textContent = '0 B';
        } else {
            showInfo("Error", "Failed to reset statistics.", true);
        }
    } catch (e) {
        showInfo("Error", "Network error while resetting statistics: " + e.message, true);
    }
}

// ============================================
// CONNECTION TEST
// ============================================
async function testConnection(type) {
    const host = document.getElementById(type + '_host').value;
    const port = document.getElementById(type + '_port').value;
    const user = document.getElementById(type + '_user').value;
    const pass = document.getElementById(type + '_pass').value;
    const secure = document.getElementById(type + '_secure').checked;

    if (!host || !user || !pass) {
        showInfo("Missing Info", "Please enter Host, User, and Password.", true);
        return;
    }

    const btn = event.currentTarget;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<svg class="animate-spin h-3.5 w-3.5 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Testing...`;

    try {
        const res = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, user, pass, secure })
        });
        const data = await res.json();

        if (data.success) {
            showInfo("Success", "Connection successful! ✅", false);
        } else {
            showInfo("Connection Failed", data.error, true);
        }
    } catch (e) {
        showInfo("Error", e.message, true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// ============================================
// FOLDER MAPPING PARSER
// ============================================
function parseFolderMapping() {
    const mapEl = document.getElementById('folderMapping');
    if (!mapEl) return {};
    const raw = mapEl.value;
    if (!raw.trim()) return {};
    const mapping = {};
    raw.split('\n').forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
            const src = parts[0].trim();
            const dest = parts.slice(1).join(':').trim();
            if (src && dest) mapping[src] = dest;
        }
    });
    return mapping;
}
