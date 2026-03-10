/* Background service worker — orchestrates the full verification flow. */

const PROVIDER_PORTAL_LOGIN = "https://www.nctracks.nc.gov/ncmmisPortal/loginAction?flow=PP";
const ELIGIBILITY_INQUIRY_URL = "https://www.nctracks.nc.gov/DirectConnect/Eligibility/Inquiry";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const INTER_PATIENT_DELAY_MS = 1500;
const TAB_LOAD_TIMEOUT_MS = 60000;
const MESSAGE_RETRY_DELAY_MS = 1500;
const MESSAGE_MAX_RETRIES = 4;
const MFA_TIMEOUT_MS = 300000; // 5 minutes
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // 24 seconds

// ─── State ───

let state = {
  status: "idle",
  patients: [],
  results: [],
  currentIndex: 0,
  totalPatients: 0,
  config: {},
  credentials: {},
  tabId: null,
  log: [],
  pendingPassword: null,
  stopRequested: false,
  lastErrorType: null,
  mfaStartTime: null,
  loginRetryCount: 0,
};

// ─── State Persistence ───

async function saveState() {
  const safe = { ...state };
  delete safe.credentials;
  delete safe.pendingPassword;
  try {
    await chrome.storage.session.set({ verifierState: safe });
  } catch {
    // session storage may not be available
  }
}

// ─── Logging ───

function addLog(message) {
  const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
  state.log.push(entry);
  if (state.log.length > 500) state.log = state.log.slice(-300);
  saveState();
  broadcastToPopup({ type: "log", message: entry });
}

function broadcastToPopup(data) {
  chrome.runtime.sendMessage(data).catch(() => {});
}

// ─── Badge & Notifications ───

function updateBadge() {
  try {
    if (state.status === "processing" && state.totalPatients > 0) {
      const text = `${state.currentIndex}/${state.totalPatients}`;
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    } else if (state.status === "done") {
      chrome.action.setBadgeText({ text: "\u2713" });
      chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    } else if (state.status === "error") {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    } else if (state.status === "mfa_waiting") {
      chrome.action.setBadgeText({ text: "MFA" });
      chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // badge API may fail during shutdown
  }
}

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch {
    // notifications may not be available
  }
}

// ─── Progress ───

function sendProgress() {
  updateBadge();
  const currentPatient = state.patients[state.currentIndex];
  let currentPatientLabel = "";
  if (currentPatient) {
    const name = `${currentPatient.first_name || ""} ${currentPatient.last_name || ""}`.trim();
    currentPatientLabel = name
      ? `${currentPatient.medicaid_id} (${name})`
      : currentPatient.medicaid_id;
  }
  broadcastToPopup({
    type: "progress",
    currentIndex: state.currentIndex,
    totalPatients: state.totalPatients,
    status: state.status,
    currentPatient: currentPatientLabel,
  });
}

// ─── Error Broadcasting ───

function broadcastError(errorType, message) {
  state.lastErrorType = errorType;
  state.status = "error";
  saveState();
  sendProgress();
  addLog(`ERROR: ${message}`);
  broadcastToPopup({
    type: "error",
    errorType: errorType,
    message: message,
  });
}

// ─── Tab Management ───

function isTabAlive(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve(false);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

async function ensureTab() {
  if (state.tabId) {
    const alive = await isTabAlive(state.tabId);
    if (alive) return state.tabId;
    addLog("Previous tab was closed. Opening a new tab...");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: "about:blank", active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Failed to create tab: " + chrome.runtime.lastError.message));
        return;
      }
      state.tabId = tab.id;
      addLog(`Opened new tab (id: ${tab.id})`);
      resolve(tab.id);
    });
  });
}

// Track tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    state.tabId = null;
    if (state.status === "processing" || state.status === "logging_in" || state.status === "mfa_waiting") {
      addLog("Browser tab was closed during operation.");
      broadcastToPopup({ type: "tabClosed" });
      state.status = "error";
      state.lastErrorType = "tab_error";
      saveState();
      sendProgress();
    }
  }
});

// ─── Tab Communication ───

function waitForTabLoad(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout — page took too long to load"));
    }, timeoutMs);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Check if already complete
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Tab no longer exists"));
        return;
      }
      if (tab && tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function sendToTab(tabId, message, retries = MESSAGE_MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    // Check tab is alive first
    const alive = await isTabAlive(tabId);
    if (!alive) {
      throw new Error("Tab no longer exists — it may have been closed");
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      const errMsg = err.message || "";
      // If content script isn't loaded, it might need more time
      if (errMsg.includes("Receiving end does not exist") || errMsg.includes("Could not establish connection")) {
        if (i < retries - 1) {
          addLog(`  Content script not ready, retrying in ${MESSAGE_RETRY_DELAY_MS}ms... (attempt ${i + 1}/${retries})`);
          await delay(MESSAGE_RETRY_DELAY_MS * (i + 1)); // exponential-ish backoff
        }
      } else {
        throw err; // Don't retry unknown errors
      }
    }
  }
  throw new Error(`Content script not responding after ${retries} attempts. The page may not have loaded correctly.`);
}

function waitForTabUrl(tabId, urlTest, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for URL change"));
    }, timeoutMs);

    function listener(id, changeInfo, tab) {
      if (id === tabId && changeInfo.url && urlTest(changeInfo.url)) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(changeInfo.url);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Check current URL
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Tab does not exist"));
        return;
      }
      if (tab && urlTest(tab.url)) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab.url);
      }
    });
  });
}

// ─── Keepalive (for MFA wait) ───

function startKeepalive() {
  chrome.alarms.create("keepalive", { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES });
}

function stopKeepalive() {
  chrome.alarms.clear("keepalive");
  chrome.alarms.clear("mfa-timeout");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Just accessing state keeps the SW alive
    if (state.status === "idle" || state.status === "done" || state.status === "error") {
      stopKeepalive();
    }
  }
  if (alarm.name === "mfa-timeout") {
    if (state.status === "mfa_waiting") {
      addLog("MFA timeout — waited too long for MFA completion.");
      broadcastError("login_failed", "MFA verification timed out after 5 minutes. Please try again.");
      stopKeepalive();
    }
  }
});

// ─── Utility ───

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Login Flow ───

async function startLogin() {
  try {
    state.status = "logging_in";
    saveState();
    sendProgress();
    addLog("Navigating to NCTracks login...");

    await ensureTab();

    await chrome.tabs.update(state.tabId, { url: PROVIDER_PORTAL_LOGIN });
    await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);

    // Wait for NCID redirect
    await delay(3000);

    // Verify we're on the right page
    const tab = await chrome.tabs.get(state.tabId);
    const url = (tab.url || "").toLowerCase();

    if (!url.includes("ncid.nc.gov") && !url.includes("nctracks.nc.gov")) {
      addLog(`Unexpected URL after login navigation: ${tab.url}`);
      broadcastError("login_failed", "Login page did not load correctly. Got unexpected URL.");
      return;
    }

    // If we landed on NCTracks directly (already logged in)
    if (url.includes("nctracks.nc.gov") && !url.includes("loginAction")) {
      addLog("Already logged in — skipping login flow.");
      await navigateToEligibility();
      processNextPatient();
      return;
    }

    addLog("Filling login credentials...");
    state.pendingPassword = state.credentials.password;

    try {
      await sendToTab(state.tabId, {
        action: "fillLogin",
        username: state.credentials.username,
        password: state.credentials.password,
      });
    } catch (err) {
      addLog("Error communicating with login page: " + err.message);

      if (state.loginRetryCount < 2) {
        state.loginRetryCount++;
        addLog(`Retrying login (attempt ${state.loginRetryCount + 1})...`);
        await delay(3000);
        await startLogin();
        return;
      }

      broadcastError("login_failed", "Could not fill login form: " + err.message);
    }
  } catch (err) {
    addLog("Login flow error: " + err.message);
    broadcastError("login_failed", err.message);
  }
}

// ─── Eligibility Navigation ───

async function navigateToEligibility() {
  addLog("Navigating to Eligibility Inquiry...");

  try {
    await ensureTab();
    await chrome.tabs.update(state.tabId, { url: ELIGIBILITY_INQUIRY_URL });
    await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
    await delay(2000);

    // Verify we landed on the right page
    const tab = await chrome.tabs.get(state.tabId);
    const url = (tab.url || "").toLowerCase();

    if (url.includes("loginaction") || url.includes("ncid.nc.gov")) {
      addLog("Redirected to login — session may have expired.");
      broadcastToPopup({ type: "sessionExpired" });

      if (state.loginRetryCount < 2) {
        state.loginRetryCount++;
        addLog("Attempting re-login...");
        await startLogin();
        return;
      }

      broadcastError("session_expired", "Session expired and re-login failed. Please try again.");
      return;
    }

    addLog("Eligibility page loaded.");
  } catch (err) {
    addLog("Failed to navigate to eligibility page: " + err.message);
    broadcastError("tab_error", "Could not load eligibility page: " + err.message);
  }
}

// ─── Batch Processing ───

async function processNextPatient() {
  try {
    // Check stop request
    if (state.stopRequested) {
      addLog("Stop requested — finishing up.");
      for (let i = state.currentIndex; i < state.patients.length; i++) {
        const p = state.patients[i];
        state.results.push({
          medicaid_id: p.medicaid_id,
          name: `${p.first_name || ""} ${p.last_name || ""}`.trim(),
          status: "SKIPPED",
          coverage_start: "",
          coverage_end: "",
          plan_name: "",
          checked_at: new Date().toISOString(),
          notes: "Stopped by user",
        });
      }
      finishBatch("Verification stopped. Results ready for download.");
      showNotification("Verification Stopped", `Processed ${state.results.length} patients. Results ready for download.`);
      return;
    }

    // Check if all done
    if (state.currentIndex >= state.patients.length) {
      const eligible = state.results.filter((r) => r.status === "ELIGIBLE" || r.status === "ACTIVE").length;
      finishBatch(`Verification complete! ${state.results.length} patients processed.`);
      showNotification(
        "Verification Complete",
        `${state.results.length} patients processed. ${eligible} eligible.`
      );
      return;
    }

    // Ensure tab is alive
    const tabAlive = await isTabAlive(state.tabId);
    if (!tabAlive) {
      addLog("Tab was closed. Attempting to recover...");
      try {
        await ensureTab();
        await navigateToEligibility();
      } catch (err) {
        broadcastError("tab_error", "Lost browser tab and could not recover: " + err.message);
        return;
      }
    }

    const patient = state.patients[state.currentIndex];
    const patientName = `${patient.first_name || ""} ${patient.last_name || ""}`.trim();
    const patientLabel = patientName
      ? `${patient.medicaid_id} (${patientName})`
      : patient.medicaid_id;

    state.status = "processing";
    sendProgress();
    addLog(`Processing patient ${state.currentIndex + 1}/${state.totalPatients}: ${patientLabel}`);

    let lastError = "";
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Check session status
        let sessionStatus;
        try {
          sessionStatus = await sendToTab(state.tabId, { action: "checkSessionStatus" });
        } catch (err) {
          addLog("Session check failed (" + err.message + ") — re-navigating...");
          await navigateToEligibility();
          sessionStatus = { expired: false, captcha: false };
        }

        if (sessionStatus.expired) {
          addLog("Session expired — re-logging in...");
          broadcastToPopup({ type: "sessionExpired" });
          state.loginRetryCount = 0;
          await startLogin();
          return; // Login flow will resume processing
        }

        if (sessionStatus.captcha) {
          addLog("CAPTCHA detected — please solve it in the browser tab.");
          broadcastToPopup({ type: "captchaRequired" });
          try {
            await sendToTab(state.tabId, { action: "waitForCaptcha" });
            addLog("CAPTCHA resolved.");
          } catch {
            addLog("CAPTCHA wait timed out — retrying...");
            continue;
          }
        }

        // Fill form and check eligibility
        const result = await sendToTab(state.tabId, {
          action: "fillAndCheck",
          patient: patient,
          config: state.config,
        });

        state.results.push({
          medicaid_id: patient.medicaid_id,
          name: patientName,
          status: result.status || "UNKNOWN",
          coverage_start: result.coverage_start || "",
          coverage_end: result.coverage_end || "",
          plan_name: result.plan_name || "",
          checked_at: new Date().toISOString(),
          notes: result.notes || "",
        });

        const statusEmoji = (result.status || "").toUpperCase() === "ELIGIBLE" ? "ELIGIBLE" :
          (result.status || "").toUpperCase() === "NOT ELIGIBLE" ? "NOT ELIGIBLE" : result.status;
        addLog(`  Result: ${statusEmoji}${result.notes ? " — " + result.notes : ""}`);
        succeeded = true;
        break;
      } catch (err) {
        lastError = err.message;
        if (attempt < MAX_RETRIES) {
          addLog(`  Attempt ${attempt} failed: ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await delay(RETRY_DELAY_MS);

          // Re-verify tab is alive before retry
          const alive = await isTabAlive(state.tabId);
          if (!alive) {
            addLog("  Tab was closed during retry. Attempting recovery...");
            try {
              await ensureTab();
              await navigateToEligibility();
            } catch (recoveryErr) {
              addLog("  Recovery failed: " + recoveryErr.message);
              break;
            }
          }
        } else {
          addLog(`  All ${MAX_RETRIES} attempts failed for ${patientLabel}: ${lastError}`);
        }
      }
    }

    if (!succeeded) {
      state.results.push({
        medicaid_id: patient.medicaid_id,
        name: patientName,
        status: "ERROR",
        coverage_start: "",
        coverage_end: "",
        plan_name: "",
        checked_at: new Date().toISOString(),
        notes: `Failed after ${MAX_RETRIES} attempts: ${lastError}`,
      });
    }

    state.currentIndex++;
    saveState();
    sendProgress();

    // Delay between patients
    await delay(INTER_PATIENT_DELAY_MS);
    processNextPatient();
  } catch (err) {
    // Catch-all for unexpected errors in processing loop
    addLog(`Unexpected error in processing loop: ${err.message}`);
    broadcastError("unknown", `Processing failed unexpectedly: ${err.message}`);
  }
}

function finishBatch(logMessage) {
  state.status = "done";
  saveState();
  sendProgress();
  addLog(logMessage);
  broadcastToPopup({ type: "complete", results: state.results });
  stopKeepalive();
}

// ─── Message Handlers ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── From NCID content script ──

  if (msg.event === "ncidPageReady") {
    addLog("NCID login page detected.");
    if (state.status === "logging_in" && state.credentials.username) {
      setTimeout(() => {
        sendToTab(state.tabId, {
          action: "fillLogin",
          username: state.credentials.username,
          password: state.credentials.password,
        }).catch((err) => {
          addLog("Failed to send credentials: " + err.message);
        });
      }, 1500);
    }
  }

  if (msg.event === "usernameSubmitted") {
    addLog("Username submitted, waiting for password step...");
    if (msg.password) state.pendingPassword = msg.password;
  }

  if (msg.event === "passwordSubmitted") {
    addLog("Password submitted, waiting for MFA or redirect...");
    state.pendingPassword = null;
  }

  if (msg.event === "mfaRequired") {
    state.status = "mfa_waiting";
    state.mfaStartTime = Date.now();
    saveState();
    sendProgress();
    addLog("MFA required — please complete verification in the browser tab.");
    broadcastToPopup({ type: "mfaRequired" });

    // Set up keepalive and timeout
    startKeepalive();
    chrome.alarms.create("mfa-timeout", { delayInMinutes: MFA_TIMEOUT_MS / 60000 });
  }

  if (msg.event === "loginComplete") {
    addLog("Login complete!");
    state.loginRetryCount = 0;
    stopKeepalive();
    navigateToEligibility().then(() => {
      processNextPatient();
    }).catch((err) => {
      broadcastError("tab_error", "Failed after login: " + err.message);
    });
  }

  if (msg.event === "loginError") {
    const errorMsg = msg.error || "Unknown login error";
    addLog("Login error: " + errorMsg);

    // Provide specific guidance based on error
    let errorType = "login_failed";
    if (errorMsg.includes("not found") || errorMsg.includes("selector")) {
      errorType = "form_error";
    }

    if (state.loginRetryCount < 2) {
      state.loginRetryCount++;
      addLog(`Retrying login (attempt ${state.loginRetryCount + 1})...`);
      setTimeout(() => startLogin(), 3000);
    } else {
      broadcastError(errorType, "Login failed: " + errorMsg);
    }
  }

  // ── From NCTracks content script ──

  if (msg.event === "ncTracksPageReady") {
    if (state.status === "logging_in" || state.status === "mfa_waiting") {
      const url = msg.url || "";
      if (url.includes("nctracks.nc.gov") && !url.includes("loginAction")) {
        addLog("Login successful — redirected to NCTracks portal.");
        state.loginRetryCount = 0;
        stopKeepalive();
        navigateToEligibility().then(() => {
          processNextPatient();
        }).catch((err) => {
          broadcastError("tab_error", "Failed after login redirect: " + err.message);
        });
      }
    }
  }

  if (msg.event === "contentScriptError") {
    addLog("Content script error: " + (msg.error || "unknown"));
  }

  // ── From popup ──

  if (msg.action === "startVerification") {
    state = {
      status: "idle",
      patients: msg.patients || [],
      results: [],
      currentIndex: 0,
      totalPatients: (msg.patients || []).length,
      config: msg.config || {},
      credentials: msg.credentials || {},
      tabId: null,
      log: [],
      pendingPassword: null,
      stopRequested: false,
      lastErrorType: null,
      mfaStartTime: null,
      loginRetryCount: 0,
    };

    if (state.patients.length === 0) {
      sendResponse({ started: false, error: "No patients provided" });
      return true;
    }

    if (!state.credentials.username || !state.credentials.password) {
      sendResponse({ started: false, error: "Credentials are required" });
      return true;
    }

    updateBadge();
    startKeepalive();
    addLog(`Starting verification for ${state.totalPatients} patients...`);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].url && !tabs[0].url.startsWith("chrome://")) {
        state.tabId = tabs[0].id;
      }
      startLogin();
    });

    sendResponse({ started: true });
  }

  if (msg.action === "stopVerification") {
    state.stopRequested = true;
    addLog("Stop requested — will finish after current patient...");
    sendResponse({ stopping: true });
  }

  if (msg.action === "getState") {
    sendResponse({
      status: state.status,
      currentIndex: state.currentIndex,
      totalPatients: state.totalPatients,
      results: state.results,
      log: state.log,
      lastErrorType: state.lastErrorType,
    });
  }

  if (msg.action === "testLogin") {
    state = {
      ...state,
      status: "idle",
      credentials: msg.credentials || {},
      config: msg.config || {},
      patients: [],
      results: [],
      currentIndex: 0,
      totalPatients: 0,
      log: [],
      stopRequested: false,
      lastErrorType: null,
      loginRetryCount: 0,
    };

    if (!state.credentials.username || !state.credentials.password) {
      sendResponse({ started: false, error: "Credentials are required" });
      return true;
    }

    addLog("Testing login...");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0 && tabs[0].url && !tabs[0].url.startsWith("chrome://")) {
        state.tabId = tabs[0].id;
      }
      startLogin();
    });

    sendResponse({ started: true });
  }

  if (msg.action === "retry") {
    if (state.status === "error" && state.patients.length > 0 && state.credentials.username) {
      addLog("Retrying from where we left off...");
      state.status = "idle";
      state.stopRequested = false;
      state.lastErrorType = null;
      state.loginRetryCount = 0;
      startKeepalive();
      navigateToEligibility()
        .then(() => processNextPatient())
        .catch((err) => broadcastError("tab_error", "Retry failed: " + err.message));
      sendResponse({ retrying: true });
    } else {
      sendResponse({ retrying: false });
    }
  }

  return true; // keep message channel open
});

// ─── Credentials Storage ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "saveCredentials") {
    chrome.storage.local.set({
      savedUsername: msg.username,
      savedPassword: msg.password,
    });
    sendResponse({ saved: true });
  }
  if (msg.action === "loadCredentials") {
    chrome.storage.local.get(["savedUsername", "savedPassword"], (data) => {
      sendResponse({
        username: data.savedUsername || "",
        password: data.savedPassword || "",
      });
    });
    return true;
  }
  if (msg.action === "clearCredentials") {
    chrome.storage.local.remove(["savedUsername", "savedPassword"]);
    sendResponse({ cleared: true });
  }
  return true;
});

// ─── Service Worker Startup Recovery ───

chrome.runtime.onStartup.addListener(() => {
  // Recover state from session storage on SW restart
  chrome.storage.session.get(["verifierState"], (data) => {
    if (data.verifierState) {
      const saved = data.verifierState;
      if (saved.status === "processing" || saved.status === "logging_in") {
        // SW was killed mid-batch — can't resume without credentials
        saved.status = "error";
        saved.lastErrorType = "service_worker";
        state = { ...state, ...saved };
        addLog("Background service was restarted. Please re-run the verification.");
        sendProgress();
      }
    }
  });
});
