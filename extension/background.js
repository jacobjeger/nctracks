/* Background service worker — orchestrates the full verification flow. */

const PROVIDER_PORTAL_LOGIN = "https://www.nctracks.nc.gov/ncmmisPortal/loginAction?flow=PP";
const ELIGIBILITY_INQUIRY_URL = "https://www.nctracks.nc.gov/DirectConnect/Eligibility/Inquiry";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const INTER_PATIENT_DELAY_MS = 1000;

// In-memory state (persisted to chrome.storage.session for popup reconnection)
let state = {
  status: "idle",          // idle | logging_in | mfa_waiting | processing | stopping | done | error
  patients: [],
  results: [],
  currentIndex: 0,
  totalPatients: 0,
  config: {},
  credentials: {},
  tabId: null,
  log: [],
  pendingPassword: null,   // stored temporarily during two-step login
  stopRequested: false,
};

/** Persist state to session storage for popup reconnection. */
async function saveState() {
  const safe = { ...state };
  // Don't persist credentials to storage
  delete safe.credentials;
  delete safe.pendingPassword;
  try {
    await chrome.storage.session.set({ verifierState: safe });
  } catch {
    // session storage may not be available
  }
}

/** Add a log entry. */
function addLog(message) {
  const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
  state.log.push(entry);
  // Keep log bounded
  if (state.log.length > 500) state.log = state.log.slice(-300);
  saveState();
  // Notify any open popup
  broadcastToPopup({ type: "log", message: entry });
}

/** Broadcast a message to the popup if it's open. */
function broadcastToPopup(data) {
  chrome.runtime.sendMessage(data).catch(() => {
    // popup not open, ignore
  });
}

/** Send progress update to popup. */
function sendProgress() {
  broadcastToPopup({
    type: "progress",
    currentIndex: state.currentIndex,
    totalPatients: state.totalPatients,
    status: state.status,
  });
}

/** Wait for a tab to finish loading. */
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout"));
    }, timeoutMs);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Send a message to the content script on a tab, with retry. */
async function sendToTab(tabId, message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch {
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  throw new Error(`Failed to send message to tab after ${retries} attempts`);
}

/** Wait for a specific URL pattern in the tab. */
function waitForTabUrl(tabId, urlTest, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("URL change timeout"));
    }, timeoutMs);

    function listener(id, changeInfo, tab) {
      if (id === tabId && changeInfo.url && urlTest(changeInfo.url)) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(changeInfo.url);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Also check current URL
    chrome.tabs.get(tabId, (tab) => {
      if (tab && urlTest(tab.url)) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab.url);
      }
    });
  });
}

/** Start the login flow. */
async function startLogin() {
  state.status = "logging_in";
  saveState();
  addLog("Navigating to NCTracks login...");

  // Navigate tab to login URL
  await chrome.tabs.update(state.tabId, { url: PROVIDER_PORTAL_LOGIN });
  await waitForTabLoad(state.tabId, 60000);

  // Wait for NCID redirect
  await new Promise((r) => setTimeout(r, 2000));

  // Send credentials to the NCID content script
  addLog("Filling login credentials...");
  state.pendingPassword = state.credentials.password;
  try {
    await sendToTab(state.tabId, {
      action: "fillLogin",
      username: state.credentials.username,
      password: state.credentials.password,
    });
  } catch (err) {
    addLog("Error sending credentials to login page: " + err.message);
    state.status = "error";
    saveState();
    sendProgress();
  }
}

/** Navigate to the eligibility inquiry page. */
async function navigateToEligibility() {
  addLog("Navigating to Eligibility Inquiry...");
  await chrome.tabs.update(state.tabId, { url: ELIGIBILITY_INQUIRY_URL });
  await waitForTabLoad(state.tabId, 60000);
  await new Promise((r) => setTimeout(r, 2000));
  addLog("Eligibility page loaded.");
}

/** Process the next patient in the queue. */
async function processNextPatient() {
  if (state.stopRequested) {
    addLog("Stop requested — finishing up.");
    // Mark remaining patients as skipped
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
    state.status = "done";
    saveState();
    sendProgress();
    addLog("Verification stopped. Results ready for download.");
    broadcastToPopup({ type: "complete", results: state.results });
    return;
  }

  if (state.currentIndex >= state.patients.length) {
    state.status = "done";
    saveState();
    sendProgress();
    addLog(`Verification complete! ${state.results.length} patients processed.`);
    broadcastToPopup({ type: "complete", results: state.results });
    return;
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
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Check session status first
      let sessionStatus;
      try {
        sessionStatus = await sendToTab(state.tabId, { action: "checkSessionStatus" });
      } catch {
        // Content script not responding — page may have changed
        addLog("Session check failed — re-navigating to eligibility page...");
        await navigateToEligibility();
        sessionStatus = { expired: false, captcha: false };
      }

      if (sessionStatus.expired) {
        addLog("Session expired — re-logging in...");
        await startLogin();
        // Login flow will eventually call back into processing
        return;
      }

      if (sessionStatus.captcha) {
        addLog("CAPTCHA detected — please solve it in the browser tab.");
        broadcastToPopup({ type: "captchaRequired" });
        await sendToTab(state.tabId, { action: "waitForCaptcha" });
        addLog("CAPTCHA resolved.");
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

      addLog(`  Result: ${result.status}${result.notes ? " — " + result.notes : ""}`);
      break; // Success, move to next patient
    } catch (err) {
      lastError = err.message;
      if (attempt < MAX_RETRIES) {
        addLog(`  Attempt ${attempt} failed: ${err.message}. Retrying...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        addLog(`  All ${MAX_RETRIES} attempts failed for ${patientLabel}`);
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
    }
  }

  state.currentIndex++;
  saveState();
  sendProgress();

  // Delay between patients
  await new Promise((r) => setTimeout(r, INTER_PATIENT_DELAY_MS));
  processNextPatient();
}

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From NCID content script
  if (msg.event === "ncidPageReady") {
    addLog("NCID login page detected.");
    // If we have pending credentials, send them
    if (state.status === "logging_in" && state.credentials.username) {
      setTimeout(() => {
        sendToTab(state.tabId, {
          action: "fillLogin",
          username: state.credentials.username,
          password: state.credentials.password,
        }).catch(() => {});
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
    saveState();
    sendProgress();
    addLog("MFA required — please complete verification in the browser tab.");
    broadcastToPopup({ type: "mfaRequired" });
  }

  if (msg.event === "loginComplete") {
    addLog("Login complete!");
    // Navigate to eligibility and start processing
    navigateToEligibility().then(() => {
      processNextPatient();
    });
  }

  if (msg.event === "loginError") {
    addLog("Login error: " + msg.error);
    state.status = "error";
    saveState();
    sendProgress();
  }

  // From NCTracks content script
  if (msg.event === "ncTracksPageReady") {
    // If we just completed login (redirected back to NCTracks)
    if (state.status === "logging_in" || state.status === "mfa_waiting") {
      const url = msg.url || "";
      if (url.includes("nctracks.nc.gov") && !url.includes("loginAction")) {
        addLog("Login successful — redirected to NCTracks portal.");
        navigateToEligibility().then(() => {
          processNextPatient();
        });
      }
    }
  }

  // From popup
  if (msg.action === "startVerification") {
    state = {
      status: "idle",
      patients: msg.patients,
      results: [],
      currentIndex: 0,
      totalPatients: msg.patients.length,
      config: msg.config || {},
      credentials: msg.credentials,
      tabId: null,
      log: [],
      pendingPassword: null,
      stopRequested: false,
    };

    addLog(`Starting verification for ${state.totalPatients} patients...`);

    // Get or create a tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        state.tabId = tabs[0].id;
      }
      startLogin();
    });

    sendResponse({ started: true });
  }

  if (msg.action === "stopVerification") {
    state.stopRequested = true;
    addLog("Stop requested...");
    sendResponse({ stopping: true });
  }

  if (msg.action === "getState") {
    sendResponse({
      status: state.status,
      currentIndex: state.currentIndex,
      totalPatients: state.totalPatients,
      results: state.results,
      log: state.log,
    });
  }

  if (msg.action === "testLogin") {
    state = {
      ...state,
      status: "idle",
      credentials: msg.credentials,
      config: msg.config || {},
      patients: [],
      results: [],
      currentIndex: 0,
      totalPatients: 0,
      log: [],
      stopRequested: false,
    };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        state.tabId = tabs[0].id;
      }
      startLogin();
    });

    sendResponse({ started: true });
  }

  return true; // keep message channel open
});

// Save credentials to local storage when user opts in
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
    return true; // async
  }
  if (msg.action === "clearCredentials") {
    chrome.storage.local.remove(["savedUsername", "savedPassword"]);
    sendResponse({ cleared: true });
  }
  return true;
});
