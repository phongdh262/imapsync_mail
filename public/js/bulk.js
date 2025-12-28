/**
 * IMAP Sync Pro - Bulk Sync Module
 * Handles batch email migration operations
 */

// ============================================
// STATE
// ============================================
let bulkJobs = [];
let isBatchRunning = false;
let shouldStopBatch = false;
let currentViewedJobId = null;

// ============================================
// CSV PARSING
// ============================================
function inferHost(email) {
    if (!email) return 'imap.gmail.com';
    if (email.includes('@gmail')) return 'imap.gmail.com';
    if (email.includes('@outlook') || email.includes('@office')) return 'outlook.office365.com';
    const parts = email.split('@');
    return parts.length > 1 ? `imap.${parts[1]}` : 'imap.gmail.com';
}

function parseCSVLine(str) {
    const arr = []; let quote = false; let col = '';
    for (let c of str) {
        if (c === '"') { quote = !quote; continue; }
        if (c === ',' && !quote) { arr.push(col); col = ''; continue; }
        col += c;
    }
    arr.push(col); return arr.map(s => s.trim());
}

function parseAndLoad() {
    const text = document.getElementById('bulkInput').value.trim();
    const defSrcHost = document.getElementById('def_src_host').value.trim();
    const defDestHost = document.getElementById('def_dest_host').value.trim();

    bulkJobs = [];
    text.split('\n').forEach(line => {
        if (!line.trim() || line.trim().startsWith('#')) return;
        const p = parseCSVLine(line.trim());
        let job = { status: 'Pending', progress: 0, id: generateUUID(), fullLogs: [] };

        if (p.length >= 8) {
            Object.assign(job, {
                src_host: p[0], src_port: p[1], src_user: p[2], src_pass: p[3],
                src_secure: (p[1] == '993'),
                dest_host: p[4], dest_port: p[5], dest_user: p[6], dest_pass: p[7],
                dest_secure: (p[5] == '993')
            });
        } else if (p.length >= 4) {
            Object.assign(job, {
                src_host: defSrcHost || inferHost(p[0]), src_port: '993', src_user: p[0], src_pass: p[1], src_secure: true,
                dest_host: defDestHost || inferHost(p[2]), dest_port: '993', dest_user: p[2], dest_pass: p[3], dest_secure: true
            });
        } else return;
        bulkJobs.push(job);
    });

    if (bulkJobs.length > 0) {
        renderJobs();
        document.getElementById('jobsContainer').classList.remove('hidden');
        document.getElementById('jobsPlaceholder').classList.add('hidden');
        document.getElementById('btnStartBatch').disabled = false;
    }
}

// ============================================
// JOB TABLE RENDERING
// ============================================
function renderJobs() {
    const tbody = document.getElementById('jobsTableBody');
    tbody.innerHTML = '';
    bulkJobs.forEach((job) => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-slate-900 transition-colors group border-b border-slate-600";
        tr.innerHTML = `
            <td class="px-6 py-4">
                <div class="flex flex-col gap-1">
                     <div class="font-bold text-slate-300 break-all" title="${job.src_user}">${job.src_user}</div>
                     <div class="text-[10px] text-slate-500 uppercase tracking-wide">to</div>
                     <div class="font-bold text-slate-300 break-all" title="${job.dest_user}">${job.dest_user}</div>
                </div>
            </td>
            <td class="px-6 py-4">
                <span id="status-${job.id}" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-slate-700 text-slate-400 border border-slate-600 mb-1">${job.status}</span>
                <div id="lastlog-${job.id}" class="text-[10px] text-slate-500 truncate w-32 cursor-pointer hover:text-blue-400 transition-colors" onclick="viewLogs('${job.id}')">${job.lastLog || 'Waiting...'}</div>
            </td>
            <td class="px-6 py-4">
                 <div class="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden mb-2 border border-slate-600"><div id="prog-${job.id}" class="bg-blue-600 h-full rounded-full transition-all" style="width: ${job.progress}%"></div></div>
            </td>
            <td class="px-6 py-4 text-right">
                 <button onclick="viewLogs('${job.id}')" class="text-xs font-bold text-slate-500 hover:text-blue-400 mr-3 transition-colors">LOGS</button>
                 <button onclick="stopJob('${job.id}')" class="text-xs font-bold text-red-400 hover:text-red-300 transition-colors ${job.status !== 'Running' ? 'hidden' : ''}" id="stop-${job.id}">STOP</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// ============================================
// BATCH STATE PERSISTENCE
// ============================================
function saveBatchState() {
    localStorage.setItem('active_batch_jobs', JSON.stringify(bulkJobs));
    localStorage.setItem('is_batch_running', isBatchRunning);
}

// ============================================
// BATCH EXECUTION
// ============================================
async function startBatch() {
    if (isBatchRunning) return;
    isBatchRunning = true;
    shouldStopBatch = false;
    document.getElementById('btnStartBatch').disabled = true;
    document.getElementById('btnStopBatch').classList.remove('hidden');

    saveBatchState();

    // Capture bulk settings once at start
    const bulkSettings = {
        dry_run: document.getElementById('bulkDryRun').checked,
        smart_map: document.getElementById('bulkSmartMap').checked,
        since_date: formatIMAPDate(document.getElementById('bulkSinceDate').value),
        exclude_folders: document.getElementById('bulkExcludeFolders').value,
        folder_mapping: parseFolderMapping()
    };

    const batchConcurrent = parseInt(document.getElementById('batchConcurrency').value) || 2;
    let idx = 0, active = 0;

    const runNext = async () => {
        if (shouldStopBatch) {
            if (active === 0) cleanupBatch();
            return;
        }

        // Skip completed jobs
        while (idx < bulkJobs.length && (bulkJobs[idx].status === 'Done' || bulkJobs[idx].status === 'Error' || bulkJobs[idx].status === 'Stopped')) {
            idx++;
        }

        if (idx >= bulkJobs.length) {
            if (active === 0) cleanupBatch();
            return;
        }
        const jobIdx = idx++; active++;
        const job = bulkJobs[jobIdx];

        job.status = 'Running';
        saveBatchState();

        const stEl = document.getElementById(`status-${job.id}`);
        if (stEl) {
            stEl.textContent = 'Running';
            stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-blue-900/30 text-blue-400 border border-blue-500/30 mb-1";
        }
        document.getElementById(`stop-${job.id}`).classList.remove('hidden');

        const threadConcurrency = parseInt(document.getElementById('concurrency').value) || 2;
        const jobData = { ...job, concurrency: threadConcurrency, sync_id: job.id, ...bulkSettings };

        await runSyncStream(jobData,
            (msg, isErr) => {
                if (job.status === 'Stopped') return;

                job.lastLog = msg;
                job.fullLogs.push({ msg, isError: isErr });
                const logEl = document.getElementById(`lastlog-${job.id}`);
                if (logEl) logEl.textContent = msg;

                // Update modal if viewing this job
                const modal = document.getElementById('logModal');
                if (!modal.classList.contains('hidden') && currentViewedJobId === job.id) {
                    const el = document.getElementById('modalLogContent');
                    const d = document.createElement('div');
                    d.className = isErr ? "text-red-400 mb-1" : "text-slate-300 mb-1";
                    d.textContent = msg;
                    el.appendChild(d);
                    el.scrollTop = el.scrollHeight;
                }

                if (isErr && msg.includes('Critical Error')) {
                    job.status = 'Error';
                    saveBatchState();
                    if (stEl) {
                        stEl.textContent = 'Failed';
                        stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-red-900/30 text-red-400 border border-red-500/30 mb-1";
                    }
                }
            },
            (prog) => {
                if (job.status === 'Stopped') return;

                job.progress = prog;
                const progEl = document.getElementById(`prog-${job.id}`);
                if (progEl) progEl.style.width = prog + '%';
                if (prog === 100) {
                    job.status = 'Done';
                    saveBatchState();
                    if (stEl) {
                        stEl.textContent = 'Done';
                        stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-emerald-900/30 text-emerald-400 border border-emerald-500/30 mb-1";
                    }
                    document.getElementById(`stop-${job.id}`).classList.add('hidden');
                }
            }
        );

        active--;
        if (shouldStopBatch) {
            if (active === 0) cleanupBatch();
        } else {
            runNext();
        }
    };

    for (let i = 0; i < batchConcurrent; i++) runNext();
}

function cleanupBatch() {
    isBatchRunning = false;
    document.getElementById('btnStartBatch').disabled = false;
    document.getElementById('btnStopBatch').classList.add('hidden');

    if (shouldStopBatch) {
        showInfo("Batch Stopped", "Batch processing has been stopped.");
    } else {
        showInfo("Batch Completed", "All jobs in the queue have been processed.");
    }

    const allDone = bulkJobs.every(j => j.status === 'Done' || j.status === 'Error' || j.status === 'Stopped');
    if (allDone) {
        localStorage.removeItem('active_batch_jobs');
        localStorage.removeItem('is_batch_running');
    }
}

async function stopBatch() {
    const ok = await showConfirm("Stop All Jobs?", "Are you sure you want to stop all running tasks? This action cannot be undone.");
    if (!ok) return;

    shouldStopBatch = true;

    const activeJobIds = bulkJobs.filter(j => j.status === 'Running' || j.status === 'Restoring').map(j => j.id);
    for (let id of activeJobIds) {
        stopJob(id, false);
    }
}

async function stopJob(id, ask = true) {
    if (ask) {
        const ok = await showConfirm("Stop Job?", "Are you sure you want to stop this migration task?");
        if (!ok) return;
    }
    try {
        await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sync_id: id }) });
        const job = bulkJobs.find(j => j.id === id);
        if (job) {
            job.status = 'Stopped';
            job.lastLog = 'Stopped by user';
            const stEl = document.getElementById(`status-${id}`);
            if (stEl) {
                stEl.textContent = 'Stopped';
                stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-slate-700 text-slate-400 border border-slate-600 mb-1";
            }
            document.getElementById(`stop-${id}`).classList.add('hidden');
        }
    } catch (e) { }
}

// ============================================
// RETRY FAILED JOBS
// ============================================
function retryFailed() {
    let count = 0;
    bulkJobs.forEach(job => {
        if (job.status === 'Error') {
            job.status = 'Pending';
            job.progress = 0;
            job.lastLog = 'Retrying...';
            const stEl = document.getElementById(`status-${job.id}`);
            if (stEl) {
                stEl.textContent = 'Pending';
                stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-slate-700 text-slate-400 border border-slate-600 mb-1";
            }
            count++;
        }
    });

    if (count > 0) {
        saveBatchState();
        startBatch();
        showInfo("Retrying", `Restarting ${count} failed jobs...`, false);
    } else {
        showInfo("No Failures", "No failed jobs to retry.", true);
    }
}

// ============================================
// REPORT EXPORT
// ============================================
function downloadReport() {
    if (!bulkJobs.length) return showInfo("No Data", "There are no jobs to export.");
    const header = ["Source", "Dest", "Status", "Last Log"];
    const rows = bulkJobs.map(j => [j.src_user, j.dest_user, j.status, `"${j.lastLog}"`]);
    const csv = "data:text/csv;charset=utf-8," + header.join(",") + "\n" + rows.map(e => e.join(",")).join("\n");
    const link = document.createElement("a");
    link.href = encodeURI(csv);
    link.download = "report.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ============================================
// VIEW LOGS MODAL
// ============================================
function viewLogs(id) {
    const job = bulkJobs.find(j => j.id === id);
    if (!job) return;
    currentViewedJobId = id;
    document.getElementById('modalTitle').textContent = `Logs: ${job.src_user}`;
    const el = document.getElementById('modalLogContent');
    el.innerHTML = job.fullLogs.map(l => `<div class="${l.isError ? 'text-red-400' : 'text-slate-300'} mb-1">${l.msg}</div>`).join('');
    document.getElementById('logModal').classList.remove('hidden');
    el.scrollTop = el.scrollHeight;
}

// ============================================
// SESSION RECOVERY - Bulk
// ============================================
async function pollJobStatus(job) {
    const sid = job.id;
    let lastLogCount = 0;
    const poll = async () => {
        if (job.status !== 'Running' && job.status !== 'Restoring') return;
        try {
            const res = await fetch(`/api/status/${sid}`);
            const st = await res.json();

            const logRes = await fetch(`/api/logs/${sid}`);
            if (logRes.ok) {
                const logs = await logRes.json();
                if (logs.length > lastLogCount) {
                    const newLogs = logs.slice(lastLogCount);
                    newLogs.forEach(l => {
                        job.lastLog = l.message;
                        job.fullLogs.push({ msg: l.message, isError: l.is_error });
                    });
                    lastLogCount = logs.length;

                    const logEl = document.getElementById(`lastlog-${job.id}`);
                    if (logEl) logEl.textContent = job.lastLog;
                    const lastProg = logs[logs.length - 1].progress;
                    if (lastProg !== undefined) {
                        job.progress = lastProg;
                        const progEl = document.getElementById(`prog-${job.id}`);
                        if (progEl) progEl.style.width = lastProg + '%';
                    }
                }
            }

            if (!st.active) {
                job.status = 'Done';
                const hasError = job.fullLogs.some(l => l.isError && l.msg.includes('Critical'));
                if (hasError) job.status = 'Error';

                const stEl = document.getElementById(`status-${job.id}`);
                if (stEl) {
                    stEl.textContent = job.status;
                    if (job.status === 'Error') stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-red-900/30 text-red-400 border border-red-500/30 mb-1";
                    else stEl.className = "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-emerald-900/30 text-emerald-400 border border-emerald-500/30 mb-1";
                }
                saveBatchState();
                return;
            }
            setTimeout(poll, 3000);
        } catch (e) { setTimeout(poll, 5000); }
    };
    poll();
}

async function restoreBulkSession() {
    const savedBatch = localStorage.getItem('active_batch_jobs');
    if (!savedBatch) return false;

    try {
        bulkJobs = JSON.parse(savedBatch);
        if (bulkJobs.length > 0) {
            switchTab('bulk');
            renderJobs();
            document.getElementById('jobsContainer').classList.remove('hidden');
            document.getElementById('jobsPlaceholder').classList.add('hidden');

            if (localStorage.getItem('is_batch_running') === 'true') {
                document.getElementById('btnStartBatch').disabled = true;
                document.getElementById('btnStopBatch').classList.remove('hidden');
                isBatchRunning = true;
            }

            let runningCount = 0;
            bulkJobs.forEach(job => {
                if (job.status === 'Running') {
                    job.status = 'Restoring';
                    pollJobStatus(job);
                    runningCount++;
                }
            });

            const hasPending = bulkJobs.some(j => j.status === 'Pending');
            if (hasPending && isBatchRunning) {
                isBatchRunning = false;
                startBatch();
            } else if (runningCount === 0 && !hasPending) {
                cleanupBatch();
            }
            return true;
        }
    } catch (e) { console.error("Batch restore error", e); }
    return false;
}
