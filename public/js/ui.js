/**
 * IMAP Sync Pro - UI Utilities Module
 * Handles modals, notifications, and UI interactions
 */

// ============================================
// CONFIRM MODAL
// ============================================
let confirmResolve = null;

function showConfirm(title, msg) {
    return new Promise((resolve) => {
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMsg').textContent = msg;
        document.getElementById('confirmModal').classList.remove('hidden');
        confirmResolve = resolve;
    });
}

function closeConfirm(result) {
    document.getElementById('confirmModal').classList.add('hidden');
    if (confirmResolve) confirmResolve(result);
    confirmResolve = null;
}

// ============================================
// INFO MODAL
// ============================================
function showInfo(title, msg) {
    document.getElementById('infoTitle').textContent = title;
    document.getElementById('infoMsg').textContent = msg;
    document.getElementById('infoModal').classList.remove('hidden');
}

function closeInfo() {
    document.getElementById('infoModal').classList.add('hidden');
}

// ============================================
// LOG MODAL
// ============================================
function closeModal() {
    document.getElementById('logModal').classList.add('hidden');
    if (typeof currentViewedJobId !== 'undefined') {
        currentViewedJobId = null;
    }
}

// ============================================
// GUIDE MODAL
// ============================================
function showGuide() {
    document.getElementById('guideModal').classList.remove('hidden');
}

function closeGuide() {
    document.getElementById('guideModal').classList.add('hidden');
}

function scrollToSection(id) {
    document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================
// SESSION RESTORE (Main Entry)
// ============================================
async function restoreSession() {
    // Try to restore single sync first
    if (typeof restoreSingleSession === 'function') {
        const singleRestored = await restoreSingleSession();
        if (singleRestored) return;
    }

    // Then try bulk sync
    if (typeof restoreBulkSession === 'function') {
        await restoreBulkSession();
    }
}
