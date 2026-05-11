const { ipcRenderer } = require('electron');

// ==========================================
// ?? CLOUD CONTROL LOGIN SYSTEM
// ==========================================
const loginScreen = document.getElementById('app-login-screen');
const loginBtn = document.getElementById('app-login-btn');
const passwordInput = document.getElementById('app-password');
const loginError = document.getElementById('app-login-error');
const togglePasswordBtn = document.getElementById('toggle-password-btn');
const dashboardTitle = document.getElementById('dashboard-title'); // Grabs the header
const defaultDashboardTitle = dashboardTitle ? dashboardTitle.innerText : "";

// ?? PASTE YOUR GOOGLE SHEET CSV LINK INSIDE THESE QUOTES:
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRdnjrT5j7dH4Q6L-SliHCBoXeA4WgxCHHQtGe55G_uLWb1v8x5lT1v_PtKku4hgK1kh-VKrTwUAroX/pub?output=csv"; 

let currentAccessCode = "";
let isAuthorizedUser = false;
let accessPollTimer = null;

async function fetchAccessStatus(accessCode) {
    const response = await fetch(SHEET_CSV_URL);
    const csvText = await response.text();
    const rows = csvText.split('\n').map(row => row.split(','));

    let isAuthorized = false;
    let isRevoked = false;
    let authorizedUsername = "User";

    for (let i = 1; i < rows.length; i++) {
        const sheetPassword = rows[i][0] ? rows[i][0].trim() : "";
        const sheetStatus = rows[i][1] ? rows[i][1].trim().toLowerCase() : "";
        const sheetUser = rows[i][2] ? rows[i][2].trim() : "";

        if (sheetPassword === accessCode) {
            if (sheetStatus === "active") {
                isAuthorized = true;
                if (sheetUser) authorizedUsername = sheetUser;
            } else if (sheetStatus === "revoked") {
                isRevoked = true;
            }
        }
    }

    if (isRevoked) {
        isAuthorized = false;
    }
    return { isAuthorized, isRevoked, authorizedUsername };
}

function showLoginScreen(message) {
    const mainDashboard = document.querySelector('.container');
    if (mainDashboard) mainDashboard.classList.remove('unlocked');
    if (dashboardTitle && defaultDashboardTitle) dashboardTitle.innerText = defaultDashboardTitle;

    loginScreen.style.display = 'flex';
    loginScreen.style.opacity = '1';
    loginScreen.style.transform = 'translateY(0) scale(1)';
    passwordInput.value = "";
    passwordInput.style.borderColor = "";

    if (message) {
        loginError.innerText = message;
        loginError.style.display = 'block';
    } else {
        loginError.style.display = 'none';
    }
}

function startAccessPolling() {
    if (accessPollTimer) clearInterval(accessPollTimer);
    accessPollTimer = setInterval(async () => {
        if (!isAuthorizedUser || !currentAccessCode) return;
        try {
            const status = await fetchAccessStatus(currentAccessCode);
            if (status.isRevoked || !status.isAuthorized) {
                isAuthorizedUser = false;
                currentAccessCode = "";
                ipcRenderer.send('force-close-windows');
                ipcRenderer.send('stop-scrape');
                showLoginScreen("? Access revoked. Please contact management.");
                if (accessPollTimer) {
                    clearInterval(accessPollTimer);
                    accessPollTimer = null;
                }
                setTimeout(() => window.location.reload(), 800);
                return;
            }
        } catch (e) {
            // Fail silently; temporary network issues shouldn't boot the user.
        }
    }, 60000);
}

// Password Visibility Toggle
if (togglePasswordBtn && passwordInput) {
    const eyeOpenSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const eyeClosedSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-6.94"></path><path d="M1 1l22 22"></path><path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a21.77 21.77 0 0 1-4.23 5.07"></path><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"></path></svg>';
    const setPasswordVisibility = (show) => {
        passwordInput.type = show ? 'text' : 'password';
        togglePasswordBtn.innerHTML = show ? eyeClosedSvg : eyeOpenSvg;
        togglePasswordBtn.setAttribute('aria-label', show ? 'Hide access code' : 'Show access code');
        togglePasswordBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
    };

    setPasswordVisibility(false);
    togglePasswordBtn.addEventListener('click', () => {
        setPasswordVisibility(passwordInput.type === 'password');
    });
}

if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
        const enteredPassword = passwordInput.value.trim();
        if (!enteredPassword) return;

        loginBtn.innerText = "Verifying...";
        loginBtn.disabled = true;
        loginError.style.display = 'none';

        try {
            const { isAuthorized, isRevoked, authorizedUsername } = await fetchAccessStatus(enteredPassword);

            if (isAuthorized) {
                // ?? Personalize the Dashboard!
                if (dashboardTitle) {
                    dashboardTitle.innerText = `Welcome, ${authorizedUsername}`;
                }

                // ?? Trigger the premium unlock animation
                loginScreen.style.opacity = '0';
                loginScreen.style.transform = 'translateY(-20px) scale(0.98)'; 
                
                const mainDashboard = document.querySelector('.container');
                if (mainDashboard) mainDashboard.classList.add('unlocked');

                setTimeout(() => { loginScreen.style.display = 'none'; }, 500);
                currentAccessCode = enteredPassword;
                isAuthorizedUser = true;
                startAccessPolling();
            } else if (isRevoked) {
                loginError.innerText = "? Access revoked. Please contact management.";
                loginError.style.display = 'block';
                passwordInput.style.borderColor = "var(--danger)";
            } else {
                loginError.innerText = "? Invalid access code.";
                loginError.style.display = 'block';
                passwordInput.style.borderColor = "var(--danger)";
            }
        } catch (error) {
            loginError.innerText = "? Network error. Check your internet connection.";
            loginError.style.display = 'block';
        }

        loginBtn.innerText = "Verify Identity";
        loginBtn.disabled = false;
    });

    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') loginBtn.click();
        });
    }
}
// ==========================================

// Safely grab elements
const startBtn = document.getElementById('startBtn');
const valTotal = document.getElementById('val-total');
const valProcessed = document.getElementById('val-processed');
const valFound = document.getElementById('val-found');
const valMissing = document.getElementById('val-missing');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const currentStatus = document.getElementById('current-status');
const statusSpinner = document.getElementById('status-spinner');
const activityList = document.getElementById('activity-list');
const openFolderBtn = document.getElementById('openFolderBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const speedSelect = document.getElementById('speedSelect');
const etaText = document.getElementById('eta-text');

// Modal Elements
const csvModal = document.getElementById('csvModal');
const cancelModalBtn = document.getElementById('cancelModalBtn');
const proceedModalBtn = document.getElementById('proceedModalBtn');

let isPaused = false;

// 📂 Open Folder Button
if (openFolderBtn) {
    openFolderBtn.addEventListener('click', () => {
        ipcRenderer.send('open-output-folder');
    });
}

// ⏸️ Pause Button
if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
        isPaused = !isPaused;
        ipcRenderer.send('toggle-pause', isPaused);
        
        if (isPaused) {
            pauseBtn.innerText = "▶️ Resume";
            pauseBtn.style.backgroundColor = "var(--success)";
        } else {
            pauseBtn.innerText = "⏸️ Pause";
            pauseBtn.style.backgroundColor = "var(--warning)";
        }
    });
}

// 🛑 Stop Button
if (stopBtn) {
    stopBtn.addEventListener('click', () => {
        if (confirm("Are you sure you want to stop the automation? Your progress will be saved safely.")) {
            stopBtn.disabled = true;
            stopBtn.innerText = "Stopping...";
            ipcRenderer.send('stop-scrape');
        }
    });
}

// 🚀 1. Show Popup when Start is clicked
if (startBtn && csvModal) {
    startBtn.addEventListener('click', () => {
        csvModal.style.display = 'flex'; // Show the warning box
    });
}

// ❌ 2. Hide Popup if they click Cancel
if (cancelModalBtn && csvModal) {
    cancelModalBtn.addEventListener('click', () => {
        csvModal.style.display = 'none';
    });
}

// ✅ 3. Actually start the scraper if they click "I Understand"
if (proceedModalBtn && csvModal) {
    proceedModalBtn.addEventListener('click', () => {
        csvModal.style.display = 'none'; // Hide the box
        
        // Lock the UI
        startBtn.disabled = true;
        if (speedSelect) speedSelect.disabled = true;
        startBtn.innerText = "Running...";
        
        if (activityList) activityList.innerHTML = ''; 
        
        if (pauseBtn) {
            pauseBtn.classList.remove('hidden');
            pauseBtn.innerText = "⏸️ Pause";
            pauseBtn.style.backgroundColor = "var(--warning)";
        }
        
        if (stopBtn) {
            stopBtn.classList.remove('hidden');
            stopBtn.disabled = false;
            stopBtn.innerText = "🛑 Stop";
        }
        isPaused = false;
        
        const progressContainer = document.getElementById('progress-container');
        if (progressContainer) progressContainer.style.display = "block";
        if (progressBar) progressBar.style.width = "0%";
        if (etaText) etaText.innerText = "ETA: Calculating...";
        
        // Grab the speed and trigger the backend
        const selectedSpeed = speedSelect ? speedSelect.value : 'normal';
        
        // 🛡️ Safely grab the toggles from the UI so it doesn't crash!
        const strictToggle = document.getElementById('strictToggle');
        const isStrictHomeownersOnly = strictToggle ? strictToggle.checked : false;
        
        const dncrToggle = document.getElementById('dncrToggle');
        const isDncrEnabled = dncrToggle ? dncrToggle.checked : true; // Default true so it checks!
        
        const outputSelect = document.getElementById('outputSelect');
        const outputMode = outputSelect ? outputSelect.value : 'csv';

        // Pass ALL settings to the backend safely
        ipcRenderer.send('start-scrape', selectedSpeed, isStrictHomeownersOnly, outputMode, isDncrEnabled);
    });
} 

// UI UPDATES FROM BACKEND
ipcRenderer.on('stats-update', (event, stats) => {
    if (valTotal) valTotal.innerText = stats.total;
    if (valProcessed) valProcessed.innerText = stats.processed;
    if (valFound) valFound.innerText = stats.found;
    if (valMissing) valMissing.innerText = stats.notFound + stats.errors;
});

let currentProgressHeader = null;

ipcRenderer.on('progress-update', (event, data) => {
    if (progressBar) progressBar.style.width = `${data.percent}%`;
    if (progressText) progressText.innerText = `${data.percent}% (${data.processed} / ${data.total})`;
    if (etaText && data.eta) etaText.innerText = `ETA: ${data.eta}`;
    
    if (!currentProgressHeader) {
        const elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, label, p');
        for (const el of elements) {
            if (el.textContent && el.textContent.trim().startsWith('Current Progress') && el.children.length === 0) {
                currentProgressHeader = el;
                break;
            }
        }
    }
    
    if (currentProgressHeader && data.fileName) {
        currentProgressHeader.textContent = `Current Progress - '${data.fileName}'`;
    }
});

ipcRenderer.on('status-update', (event, data) => {
    if (currentStatus) currentStatus.innerText = data.msg;
    if (statusSpinner) {
        if (data.isSpinning) statusSpinner.classList.remove('hidden');
        else statusSpinner.classList.add('hidden');
    }
});

ipcRenderer.on('activity-update', (event, data) => {
    if (!activityList) return;
    if (activityList.innerHTML.includes('No activity yet')) activityList.innerHTML = '';

    const li = document.createElement('li');
    li.className = 'activity-item';
    
    let badge = '';
    if (data.type === 'success') badge = '<span class="badge badge-success">Found</span>';
    else if (data.type === 'warning') badge = '<span class="badge badge-warning">No Match</span>';
    else if (data.type === 'danger') badge = '<span class="badge badge-danger">Error</span>';
    else badge = '<span class="badge badge-info">Info</span>';

    li.innerHTML = `${badge} <span>${data.msg}</span>`;
    activityList.insertBefore(li, activityList.firstChild);
    
    if (activityList.children.length > 50) activityList.removeChild(activityList.lastChild);
});

ipcRenderer.on('scrape-finished', () => {
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerText = "Select CSV & Start Again";
    }
    if (speedSelect) speedSelect.disabled = false;
    if (statusSpinner) statusSpinner.classList.add('hidden');
    if (pauseBtn) pauseBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    if (etaText) etaText.innerText = "ETA: Done";
    
    if (currentProgressHeader) {
        currentProgressHeader.textContent = "Current Progress";
    }
});
