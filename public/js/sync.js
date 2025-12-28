/**
 * IMAP Sync Pro - Single Sync Module
 * Handles single account email synchronization
 */

// ============================================
// STATE
// ============================================
let currentSyncId = null;

// ============================================
// UI ELEMENTS
// ============================================
const startBtn = document.getElementById('startSync');
const stopBtn = document.getElementById('stopSync');
const logsDiv = document.getElementById('logs');

// ============================================
// LOG MANAGEMENT
// ============================================
function appendLog(msg, isError = false) {
    // Remove placeholder
    if (logsDiv.querySelector('.italic')) logsDiv.innerHTML = '';

    const div = document.createElement('div');
    let content = msg;

    // Simple Syntax Highlighting
    if (!isError) {
        if (msg.includes('Synced')) content = `<span class="text-blue-400 font-bold">Synced</span> ${msg.replace('Synced', '').replace('->', '<span class="text-slate-500">-></span>')}`;
        else if (msg.includes('Mapping')) content = `<span class="text-purple-400 font-bold">Mapping</span> ${msg.replace('Mapping', '')}`;
        else if (msg.includes('Connecting') || msg.includes('Connected')) content = `<span class="text-yellow-400 font-bold">${msg.includes('Connecting') ? 'Connecting' : 'Connected'}</span> ${msg.replace('Connecting', '').replace('Connected', '')}`;
        else if (msg.includes('Completed') || msg.includes('Success')) content = `<span class="text-green-400 font-bold">✓</span> <span class="text-green-300">${msg}</span>`;
    }

    div.className = isError
        ? 'text-red-400 mb-1 border-l-2 border-red-500/50 pl-2 font-mono text-xs'
        : 'mb-1 border-l-2 border-slate-700 pl-2 font-mono text-xs text-slate-300 hover:bg-slate-800/30 transition-colors';

    div.innerHTML = content;
    logsDiv.appendChild(div);
    logsDiv.scrollTop = logsDiv.scrollHeight;
}

function downloadLog() {
    const text = logsDiv.innerText;
    if (!text) { showInfo("No Logs", "Terminal is empty.", true); return; }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `imap-sync-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// ============================================
// SSE STREAM HANDLER
// ============================================
async function runSyncStream(data, logCtx, progCtx) {
    try {
        const response = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const lines = decoder.decode(value).split('\n\n');
            lines.forEach(line => {
                if (line.startsWith('data: ')) {
                    try {
                        const p = JSON.parse(line.replace('data: ', ''));
                        logCtx(p.message, p.is_error);
                        if (p.progress !== undefined) progCtx(p.progress);

                        if (p.message === 'Sync completed!' || p.message === 'Stopped by user.') {
                            localStorage.removeItem('active_sync_id');
                        }
                    } catch (e) { }
                }
            });
        }
    } catch (err) { logCtx("Network Error: " + err, true); }
}

// ============================================
// START/STOP SYNC
// ============================================
if (startBtn) {
    startBtn.addEventListener('click', async () => {
        try {
            // Verify Critical Elements exist
            if (!document.getElementById('syncArrow')) throw new Error("Missing UI Element: syncArrow");

            const folderMap = parseFolderMapping();
            const data = {
                src_host: document.getElementById('src_host').value,
                src_port: document.getElementById('src_port').value,
                src_user: document.getElementById('src_user').value,
                src_pass: document.getElementById('src_pass').value,
                src_secure: document.getElementById('src_secure').checked,
                dest_host: document.getElementById('dest_host').value,
                dest_port: document.getElementById('dest_port').value,
                dest_user: document.getElementById('dest_user').value,
                dest_pass: document.getElementById('dest_pass').value,
                dest_secure: document.getElementById('dest_secure').checked,
                concurrency: document.getElementById('concurrency').value,
                sync_id: generateUUID(),
                dry_run: document.getElementById('dryRun').checked,
                smart_map: document.getElementById('smartMap').checked,
                since_date: formatIMAPDate(document.getElementById('sinceDate').value),
                exclude_folders: document.getElementById('excludeFolders').value,
                folder_mapping: folderMap
            };
            currentSyncId = data.sync_id;

            if (!data.src_host || !data.src_user || !data.src_pass) {
                showInfo("Configuration Error", "Please fill in all required Source and Destination fields.");
                return;
            }

            // Save session
            localStorage.setItem('active_sync_id', currentSyncId);
            localStorage.setItem('active_sync_config', JSON.stringify(data));

            startBtn.disabled = true;
            startBtn.style.opacity = '0.5';
            stopBtn.classList.remove('hidden');
            logsDiv.innerHTML = '';

            if (Object.keys(folderMap).length > 0) {
                appendLog(`>>> Folder Mapping Configured: ${Object.keys(folderMap).length} rules.`, false);
            }
            if (data.dry_run) appendLog(">>> DRY RUN MODE: No data will be transferred.", false);
            appendLog("Connecting... (Waiting for Server Response)", false);

            document.getElementById('syncArrow').classList.add('pulse-active');

            await runSyncStream(data, (msg, isErr) => {
                appendLog(msg, isErr);

                // Client-side Stat Counting
                if (msg.includes('Synced')) {
                    let count = parseInt(document.getElementById('stat_emails').textContent.replace(/,/g, '')) || 0;
                    document.getElementById('stat_emails').textContent = (count + 1).toLocaleString();
                }
                if (msg === 'Sync completed!') {
                    confetti({
                        particleCount: 150,
                        spread: 70,
                        origin: { y: 0.6 },
                        colors: ['#60a5fa', '#34d399', '#f472b6']
                    });
                }
            }, () => { });

            document.getElementById('syncArrow').classList.remove('pulse-active');
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
            stopBtn.classList.add('hidden');

        } catch (err) {
            console.error(err);
            showInfo("Start Error", err.message, true);
            startBtn.disabled = false;
            startBtn.style.opacity = '1';
        }
    });
}

if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
        if (currentSyncId) {
            await fetch('/api/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sync_id: currentSyncId })
            });
            localStorage.removeItem('active_sync_id');
        }
    });
}

// ============================================
// SESSION RECOVERY - Single Sync
// ============================================
async function restoreSingleSession() {
    const sid = localStorage.getItem('active_sync_id');
    if (!sid) return false;

    try {
        const res = await fetch(`/api/status/${sid}`);
        const status = await res.json();
        if (status.active) {
            const config = JSON.parse(localStorage.getItem('active_sync_config') || '{}');
            if (config.src_host) document.getElementById('src_host').value = config.src_host;
            if (config.dest_host) document.getElementById('dest_host').value = config.dest_host;
            currentSyncId = sid;

            switchTab('single');
            startBtn.disabled = true;
            startBtn.style.opacity = '0.5';
            stopBtn.classList.remove('hidden');
            logsDiv.innerHTML = '';
            appendLog(">>> Restoring session connection...", false);
            pollLogs(sid);
            return true;
        } else {
            localStorage.removeItem('active_sync_id');
        }
    } catch (e) { }
    return false;
}

async function pollLogs(sid) {
    let lastLogCount = 0;
    const poll = async () => {
        if (!currentSyncId) return;
        try {
            const res = await fetch(`/api/status/${sid}`);
            const st = await res.json();

            const logRes = await fetch(`/api/logs/${sid}`);
            if (logRes.ok) {
                const logs = await logRes.json();
                if (logs.length > lastLogCount) {
                    const newLogs = logs.slice(lastLogCount);
                    newLogs.forEach(l => appendLog(l.message, l.is_error || l.i_error));
                    lastLogCount = logs.length;
                }
            }

            if (!st.active) {
                startBtn.disabled = false;
                startBtn.style.opacity = '1';
                stopBtn.classList.add('hidden');
                appendLog(">>> Process finished.", false);
                localStorage.removeItem('active_sync_id');
                currentSyncId = null;
                return;
            }

            setTimeout(poll, 2000);
        } catch (e) { setTimeout(poll, 5000); }
    };
    poll();
}
