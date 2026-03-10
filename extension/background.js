/* Background service worker — orchestrates the full verification flow. */

// Import shared config (available in service worker via importScripts)
try { importScripts("config.js"); } catch { /* may already be loaded */ }

const PROVIDER_PORTAL_LOGIN = "https://www.nctracks.nc.gov/ncmmisPortal/loginAction?flow=PP";
const ELIGIBILITY_INQUIRY_URL = "https://www.nctracks.nc.gov/DirectConnect/Eligibility/Inquiry";
const PASSAGEHEALTH_LOGIN_URL = "https://clinical.passagehealth.com";
const PASSAGEHEALTH_REPORTS_URL = "https://clinical.passagehealth.com/dashboard/reporting/clients";
const EMR_PAGE_LOAD_DELAY_MS = 3000;
const EMR_MAX_PAGES = 100; // Safety limit for pagination
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const INTER_PATIENT_DELAY_MS = 1500;
const TAB_LOAD_TIMEOUT_MS = 60000;
const MESSAGE_RETRY_DELAY_MS = 1500;
const MESSAGE_MAX_RETRIES = 4;
const MFA_TIMEOUT_MS = 300000; // 5 minutes
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // 24 seconds

// ─── TOTP Generator (RFC 6238) ───
// Pure JS implementation — no dependencies. Generates 6-digit TOTP codes
// from a base32-encoded secret (the kind you get when setting up an authenticator app).

function base32Decode(encoded) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  const clean = encoded.replace(/[\s=-]+/g, "").toUpperCase();
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

async function hmacSha1(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(sig);
}

async function generateTOTP(base32Secret, periodSeconds = 30, digits = 6) {
  const keyBytes = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / periodSeconds);
  // Counter as big-endian 8-byte buffer
  const counterBuf = new ArrayBuffer(8);
  const view = new DataView(counterBuf);
  view.setUint32(4, counter, false); // low 32 bits (high 32 are 0 for decades)
  const hash = await hmacSha1(keyBytes, counterBuf);
  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

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
  // Session expiry tracking
  trueExpiryCount: 0,
  falseAlarmCount: 0,
  // Login suppression (Fix 6)
  lastLoginSuccessTime: 0,
};

// Guard against concurrent processNextPatient calls
let processingActive = false;

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

function showNotification(title, message, options = {}) {
  try {
    const notifOptions = {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      ...options,
    };
    chrome.notifications.create(notifOptions);
  } catch {
    // notifications may not be available
  }
}

// ─── Name Validation ───

const NAME_LABEL_NOISE = [
  "last name:", "first name:", "date of birth:", "name:", "dob:",
  "recipient name:", "recipient id:", "gender:", "admin county code:",
  "primary care provider:", "daytime phone:", "address:",
  "tailored care manager:", "tribal member:",
];

/**
 * Clean a scraped name by removing label text contamination,
 * and flag names that look truncated (no spaces / obvious concatenation).
 * Returns { name, nameWarning }.
 */
function validateScrapedName(rawName, fallback) {
  let name = (rawName || fallback || "").trim();

  // Strip any label fragments that leaked into the scraped value
  const lower = name.toLowerCase();
  for (const label of NAME_LABEL_NOISE) {
    const idx = lower.indexOf(label);
    if (idx !== -1) {
      name = (name.slice(0, idx) + name.slice(idx + label.length)).trim();
    }
  }
  // Collapse multiple spaces left over from stripping
  name = name.replace(/\s{2,}/g, " ").trim();

  // Flag names that look truncated or concatenated
  let nameWarning = "";
  if (name.length > 0) {
    const hasSpace = /\s/.test(name);
    // A single-word name longer than 10 chars is likely two names glued together
    if (!hasSpace && name.length > 10) {
      nameWarning = "Name may be truncated — verify manually";
    }
    // Even shorter single-word names are suspicious if they look like two names
    // e.g. all-caps with an obvious boundary (lowercase→uppercase rarely happens in NCTracks)
    if (!hasSpace && name.length > 5 && /[a-z][A-Z]/.test(name)) {
      nameWarning = "Name may be truncated — verify manually";
    }
  }

  return { name, nameWarning };
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
  showNotification("Verification Error", message);
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

async function ensureTab(url) {
  if (state.tabId) {
    const alive = await isTabAlive(state.tabId);
    if (alive) return state.tabId;
    addLog("Previous tab was closed. Opening a new one...");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: url || "about:blank", active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Failed to create tab: " + chrome.runtime.lastError.message));
        return;
      }
      state.tabId = tab.id;
      addLog(`Opened tab (id: ${tab.id})`);
      resolve(tab.id);
    });
  });
}

// Track tab removal — attempt recovery instead of stopping
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    state.tabId = null;
    if (state.status === "processing" || state.status === "logging_in" || state.status === "mfa_waiting") {
      addLog("Browser tab was closed. Attempting to recover...");
      // Don't stop — let ensureTab() create a new tab on next iteration
      // The processing loop already calls ensureTab() and handles missing tabs
      if (state.status === "mfa_waiting") {
        // MFA can't be recovered — user needs the original tab
        addLog("MFA tab was closed — cannot recover MFA session.");
        broadcastToPopup({ type: "tabClosed" });
        state.status = "error";
        state.lastErrorType = "tab_error";
        saveState();
        sendProgress();
        showNotification("MFA Tab Closed", "The MFA tab was closed. Please restart verification.");
      }
      // For processing/logging_in, the loop will recover automatically
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

// ─── Keepalive ───
// Chrome MV3 service workers get terminated after ~30s of inactivity.
// We use multiple strategies to stay alive during processing:
// 1. chrome.alarms (min 30s period) as a safety net
// 2. Port-based keepalive from content scripts (instant reconnect)
// 3. Self-pinging during long delays

let keepalivePorts = new Set();

function startKeepalive() {
  try {
    chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  } catch (e) {
    // alarms API may not be available
  }
}

function stopKeepalive() {
  try {
    chrome.alarms.clear("keepalive");
    chrome.alarms.clear("mfa-timeout");
  } catch {
    // ignore
  }
}

// Port-based keepalive: content scripts connect and hold a port open,
// which prevents Chrome from killing the service worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    keepalivePorts.add(port);
    port.onDisconnect.addListener(() => {
      keepalivePorts.delete(port);
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Accessing state keeps the SW alive
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

// Delay that keeps the service worker alive by chunking into short intervals
function delay(ms) {
  return new Promise((resolve) => {
    if (ms <= 5000) {
      setTimeout(resolve, ms);
    } else {
      // For longer delays, chunk into 4s intervals to prevent SW termination
      let remaining = ms;
      const tick = () => {
        if (remaining <= 0) return resolve();
        const wait = Math.min(remaining, 4000);
        remaining -= wait;
        setTimeout(tick, wait);
      };
      tick();
    }
  });
}

// ─── Login Flow ───

async function startLogin() {
  try {
    state.status = "logging_in";
    state.pendingPassword = state.credentials.password;
    saveState();
    sendProgress();
    addLog("Opening NCTracks login page...");

    // Create tab directly with the login URL (or reuse existing tab)
    const tabAlive = state.tabId && await isTabAlive(state.tabId);
    if (tabAlive) {
      chrome.tabs.update(state.tabId, { url: PROVIDER_PORTAL_LOGIN, active: true });
    } else {
      await ensureTab(PROVIDER_PORTAL_LOGIN);
    }

    // Wait for NCID or NCTracks to appear
    addLog("Waiting for redirect to NCID...");
    let finalUrl = "";
    try {
      finalUrl = await waitForTabUrl(
        state.tabId,
        (url) => url.includes("ncid.nc.gov") || url.includes("nctracks.nc.gov"),
        TAB_LOAD_TIMEOUT_MS
      );
      addLog("Page reached: " + finalUrl.substring(0, 80));
    } catch {
      const tab = await chrome.tabs.get(state.tabId);
      finalUrl = tab.url || "";
      addLog("Timeout — current URL: " + finalUrl.substring(0, 80));
    }

    // Wait for full page load
    try {
      await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
    } catch {
      addLog("Page load timed out — continuing");
    }

    await delay(1000);

    // Check where we ended up
    const tab = await chrome.tabs.get(state.tabId);
    const url = (tab.url || "").toLowerCase();
    addLog("Current URL: " + tab.url.substring(0, 80));

    // Already logged in?
    if (url.includes("nctracks.nc.gov") && !url.includes("loginaction")) {
      addLog("Already logged in.");
      state.status = "processing"; // Prevent ncTracksPageReady from re-triggering
      await navigateToEligibility();
      processNextPatient();
      return;
    }

    // Send credentials to the content script on the NCID page
    // The ncidPageReady handler also sends credentials as a backup
    addLog("Sending credentials to login page...");
    try {
      await sendToTab(state.tabId, {
        action: "fillLogin",
        username: state.credentials.username,
        password: state.credentials.password,
      }, 8);
      addLog("Credentials delivered.");
    } catch (err) {
      addLog("Content script unreachable: " + err.message);

      if (state.loginRetryCount < 2) {
        state.loginRetryCount++;
        addLog("Retrying login (attempt " + (state.loginRetryCount + 1) + ")...");
        await delay(3000);
        return startLogin();
      }

      broadcastError("login_failed", "Could not communicate with login page: " + err.message);
    }
  } catch (err) {
    addLog("Login error: " + err.message);
    broadcastError("login_failed", err.message);
  }
}

// ─── Eligibility Navigation ───

async function navigateToEligibility() {
  addLog("Navigating to Eligibility Inquiry...");

  try {
    await ensureTab();
    await chrome.tabs.update(state.tabId, { url: ELIGIBILITY_INQUIRY_URL });
    // Fix 5: If page takes >15s, retry navigation once
    try {
      await waitForTabLoad(state.tabId, 15000);
    } catch {
      addLog("Page load slow (>15s) — retrying navigation once...");
      await chrome.tabs.update(state.tabId, { url: ELIGIBILITY_INQUIRY_URL });
      await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
    }
    await delay(2000);

    // Fix 6: If we just logged in within 15s, skip expiry detection entirely
    const LOGIN_SUPPRESSION_MS = 15000;
    if (state.lastLoginSuccessTime && (Date.now() - state.lastLoginSuccessTime) < LOGIN_SUPPRESSION_MS) {
      addLog("Login suppression active (within 15s of login) — skipping session check.");
      // Wait for form readiness instead
      try {
        await waitForEligibilityForm(state.tabId);
        addLog("Eligibility page loaded — form confirmed present.");
      } catch {
        addLog("Eligibility page loaded but form field not confirmed — proceeding anyway.");
      }
      return;
    }

    // Verify we landed on the right page — with retry logic (Fix 1)
    // When navigating between patients, a slow redirect can look like session expiry.
    // Wait and re-check up to 3 times before concluding it's a true expiry.
    const SESSION_CHECK_RETRIES = 3;
    const SESSION_CHECK_DELAY_MS = 3000;
    let confirmedExpired = false;

    for (let check = 1; check <= SESSION_CHECK_RETRIES; check++) {
      const tab = await chrome.tabs.get(state.tabId);
      const url = (tab.url || "").toLowerCase();

      if (url.includes("loginaction") || url.includes("ncid.nc.gov")) {
        if (check < SESSION_CHECK_RETRIES) {
          addLog(`Session check ${check}/${SESSION_CHECK_RETRIES}: redirected to login — waiting ${SESSION_CHECK_DELAY_MS / 1000}s to re-check...`);
          await delay(SESSION_CHECK_DELAY_MS);
          // Re-check the current URL (page may have recovered/redirected back)
          continue;
        }
        // Final check still shows login page
        confirmedExpired = true;
      } else {
        // Page recovered or was never expired
        if (check > 1) {
          addLog(`FALSE ALARM - RECOVERED on check ${check}/${SESSION_CHECK_RETRIES}`);
          state.falseAlarmCount++;
        }
        break;
      }
    }

    if (confirmedExpired) {
      addLog("TRUE EXPIRY — session has expired after all re-checks.");
      state.trueExpiryCount++;
      broadcastToPopup({ type: "sessionExpired" });
      showNotification("Session Issue — NCTracks Verifier",
        "Attempting to recover session... if this persists please check the NCTracks tab.");

      if (state.loginRetryCount < 2) {
        state.loginRetryCount++;
        addLog("Attempting re-login...");
        await startLogin();
        return;
      }

      broadcastError("session_expired", "Session expired and re-login failed. Please try again.");
      return;
    }

    // Wait for the actual eligibility form input field to be present (Fix 2)
    // Don't just trust page load — confirm the form is usable
    try {
      await waitForEligibilityForm(state.tabId);
      addLog("Eligibility page loaded — form confirmed present.");
    } catch {
      addLog("Eligibility page loaded but form field not confirmed — proceeding anyway.");
    }
  } catch (err) {
    addLog("Failed to navigate to eligibility page: " + err.message);
    broadcastError("tab_error", "Could not load eligibility page: " + err.message);
  }
}

// Wait for the actual eligibility form to be present on the page (Fix 2)
async function waitForEligibilityForm(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await sendToTab(tabId, { action: "checkFormReady" });
      if (result && result.formReady) return true;
    } catch {
      // Content script may not be ready yet
    }
    await delay(1000);
  }
  throw new Error("Eligibility form not detected within timeout");
}

// ─── EMR Orchestration ───

async function startFromEMR() {
  addLog("=== Phase: EMR Login ===");
  state.status = "emr_login";
  saveState();
  sendProgress();

  try {
    await ensureTab();
    addLog(`Opening Passage Health login page: ${PASSAGEHEALTH_LOGIN_URL}`);
    await chrome.tabs.update(state.tabId, { url: PASSAGEHEALTH_LOGIN_URL });
    await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
    await delay(EMR_PAGE_LOAD_DELAY_MS);

    // Check what page we're on
    let pageCheck;
    try {
      pageCheck = await sendToTab(state.tabId, { action: "emrCheckPage" });
      addLog(`EMR page type: ${pageCheck.pageType} — URL: ${pageCheck.url}`);
    } catch (err) {
      addLog(`Could not check EMR page: ${err.message} — trying login anyway...`);
      pageCheck = { pageType: "login" };
    }

    if (pageCheck.pageType === "login") {
      // Need to log in
      addLog("Sending login credentials to EMR...");
      const loginResult = await sendToTab(state.tabId, {
        action: "emrLogin",
        email: state.emrCredentials.email,
        password: state.emrCredentials.password,
      });
      addLog(`EMR login result: ${loginResult.status} — ${loginResult.notes || ""}`);

      if (loginResult.status === "ERROR") {
        broadcastError("emr_login_failed", `EMR login failed: ${loginResult.notes}`);
        return;
      }

      // Wait for navigation after login
      addLog("Waiting for EMR login to complete...");
      await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
      await delay(EMR_PAGE_LOAD_DELAY_MS);

      // Verify we're logged in
      try {
        pageCheck = await sendToTab(state.tabId, { action: "emrCheckPage" });
        addLog(`After login — page type: ${pageCheck.pageType}, URL: ${pageCheck.url}`);
      } catch {
        addLog("Could not verify login — proceeding anyway...");
      }

      if (pageCheck.pageType === "login") {
        // Still on login page — credentials may be wrong
        broadcastError("emr_login_failed", "EMR login failed — still on login page. Check your credentials.");
        return;
      }
    } else if (pageCheck.pageType === "dashboard" || pageCheck.pageType === "reports") {
      addLog("Already logged into EMR");
    }

    // ── Navigate to Reports Page via Sidebar ──
    addLog("=== Phase: EMR Scrape ===");
    state.status = "emr_scraping";
    saveState();
    broadcastToPopup({ type: "emrProgress", phase: "navigating", patientsFound: 0 });

    addLog("Navigating to Client Reports via sidebar navigation...");
    const navResult = await sendToTab(state.tabId, { action: "emrNavigateToReports" });
    addLog(`Sidebar navigation result: status=${navResult.status}, url=${navResult.url || "?"}, pageType=${navResult.pageType || "?"}`);

    if (navResult.status === "ERROR") {
      // Fallback: try direct URL navigation as last resort
      addLog(`Sidebar navigation failed: ${navResult.notes} — falling back to direct URL...`);
      await chrome.tabs.update(state.tabId, { url: PASSAGEHEALTH_REPORTS_URL });
      await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
      await delay(EMR_PAGE_LOAD_DELAY_MS);
    } else if (navResult.status === "PARTIAL") {
      addLog(`Sidebar navigation partial — waiting extra time for page to settle...`);
      await delay(EMR_PAGE_LOAD_DELAY_MS);
    }

    // Verify we're on the reports page
    try {
      pageCheck = await sendToTab(state.tabId, { action: "emrCheckPage" });
      addLog(`Reports page — type: ${pageCheck.pageType}, URL: ${pageCheck.url}`);
    } catch (err) {
      addLog(`Could not verify reports page: ${err.message}`);
    }

    if (pageCheck.pageType !== "reports") {
      addLog(`Warning: May not be on reports page (type=${pageCheck.pageType}). Attempting to continue anyway...`);
    }

    // ── Apply Filters ──
    addLog("Applying filters (Active status, funding sources)...");
    broadcastToPopup({ type: "emrProgress", phase: "filtering", patientsFound: 0 });

    const filterResult = await sendToTab(state.tabId, { action: "emrApplyFilters" });
    addLog(`Filter result: status=${filterResult.status}, statusApplied=${filterResult.statusApplied}, fundingApplied=${filterResult.fundingApplied}`);
    if (filterResult.diagnostics) addLog(`Filter diagnostics: ${filterResult.diagnostics}`);

    // ── Scrape All Pages ──
    addLog("Scraping patient data from report...");
    let allPatients = [];
    let pageNum = 0;

    while (pageNum < EMR_MAX_PAGES) {
      pageNum++;
      addLog(`Scraping page ${pageNum}...`);
      broadcastToPopup({ type: "emrProgress", phase: "scraping", page: pageNum, patientsFound: allPatients.length });

      const scrapeResult = await sendToTab(state.tabId, { action: "emrScrapePage" });
      addLog(`Page ${pageNum}: ${scrapeResult.patients ? scrapeResult.patients.length : 0} patients found (status: ${scrapeResult.status})`);

      if (scrapeResult.patients && scrapeResult.patients.length > 0) {
        allPatients = allPatients.concat(scrapeResult.patients);
      }

      if (scrapeResult.status === "ERROR" || scrapeResult.status === "NO_TABLE") {
        addLog(`Scrape issue on page ${pageNum}: ${scrapeResult.diagnostics || scrapeResult.status}`);
        break;
      }

      // Try next page
      const nextResult = await sendToTab(state.tabId, { action: "emrNextPage" });
      if (!nextResult.hasMore) {
        addLog(`No more pages after page ${pageNum}`);
        break;
      }
      await delay(1000);
    }

    // ── Deduplicate ──
    const beforeDedup = allPatients.length;
    const seen = new Map();
    for (const p of allPatients) {
      if (!seen.has(p.medicaid_id)) {
        seen.set(p.medicaid_id, p);
      }
    }
    allPatients = Array.from(seen.values());
    addLog(`EMR scrape complete: ${beforeDedup} patients found across ${pageNum} pages`);
    if (beforeDedup !== allPatients.length) {
      addLog(`Deduplicated: ${beforeDedup} → ${allPatients.length} unique Medicaid IDs`);
    }

    // ── Post-scrape filtering (safety net) ──
    // Filter by configured funding sources in case UI filters weren't applied
    const cfg = typeof NCTRACKS_CONFIG !== "undefined" ? NCTRACKS_CONFIG : (globalThis.NCTRACKS_CONFIG || {});
    const allowedSources = cfg.PASSAGEHEALTH_FUNDING_SOURCES || [];
    if (allowedSources.length > 0 && allPatients.length > 0) {
      const beforeFundingFilter = allPatients.length;
      allPatients = allPatients.filter((p) => {
        if (!p.emr_funding_source) return false;
        const src = p.emr_funding_source.toLowerCase();
        return allowedSources.some((allowed) => src.includes(allowed.toLowerCase()));
      });
      if (allPatients.length < beforeFundingFilter) {
        addLog(`Post-scrape funding filter: ${beforeFundingFilter} → ${allPatients.length} patients (removed ${beforeFundingFilter - allPatients.length} with non-matching funding sources)`);
      }
    }

    broadcastToPopup({ type: "emrProgress", phase: "complete", patientsFound: allPatients.length });

    if (allPatients.length === 0) {
      broadcastError("emr_scrape_failed", "No patients found in EMR report. Check filters and report data.");
      return;
    }

    // ── Store patients and proceed to NCTracks ──
    state.patients = allPatients;
    state.totalPatients = allPatients.length;
    state.currentIndex = 0;
    state.results = [];
    saveState();

    addLog(`=== Phase: NCTracks Login ===`);
    addLog(`Proceeding to verify ${state.totalPatients} patients on NCTracks...`);
    broadcastToPopup({ type: "emrProgress", phase: "nctracks", patientsFound: allPatients.length });
    sendProgress();

    // Now start the NCTracks login flow
    state.loginRetryCount = 0;
    await startLogin();

  } catch (err) {
    addLog(`EMR flow error: ${err.message}`);
    broadcastError("emr_error", `EMR error: ${err.message}`);
  }
}

// ─── Payer Comparison ───

function checkPayerChanged(emrFundingSource, ncTracksEntity) {
  if (!emrFundingSource || !ncTracksEntity) return "";
  const mapping = typeof NCTRACKS_CONFIG !== "undefined" ? NCTRACKS_CONFIG.PAYER_MAPPING : (globalThis.NCTRACKS_CONFIG || {}).PAYER_MAPPING;
  if (!mapping) return "";
  // Try to find the matching mapping key
  let expectedPattern = mapping[emrFundingSource];
  if (!expectedPattern) {
    // Fuzzy match — check if the EMR source contains any known key
    for (const [key, pattern] of Object.entries(mapping)) {
      if (emrFundingSource.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(emrFundingSource.toLowerCase())) {
        expectedPattern = pattern;
        break;
      }
    }
  }
  if (!expectedPattern) return "UNKNOWN";
  return ncTracksEntity.toUpperCase().includes(expectedPattern.toUpperCase()) ? "NO" : "YES";
}

// ─── Batch Processing ───

async function processNextPatient() {
  // Prevent concurrent calls — multiple event handlers can trigger this
  if (processingActive) {
    addLog("(Skipping duplicate processNextPatient call)");
    return;
  }
  processingActive = true;

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
          emr_funding_source: p.emr_funding_source || "",
          managing_entity: "",
          managing_entity_next: "",
          current_period: "",
          next_period: "",
          payer_changed: "",
          payer_changed_next: "",
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
      const errors = state.results.filter((r) => r.status === "ERROR").length;
      const payerChanges = state.results.filter((r) => r.payer_changed_next === "YES").length;
      finishBatch(`Verification complete! ${state.results.length} patients processed.`);
      showNotification(
        "Verification Complete — NCTracks Verifier",
        `${state.results.length} patients processed. ${eligible} eligible. ${payerChanges} payer changes detected. ${errors} errors. Results exported.`
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
        processingActive = false;
        broadcastError("tab_error", "Lost browser tab and could not recover: " + err.message);
        return;
      }
    }

    // Fix 3: Proactive session health check every 5 patients
    if (state.currentIndex > 0 && state.currentIndex % 5 === 0) {
      addLog(`[Health Check] Patient ${state.currentIndex + 1} — verifying session before continuing...`);
      let healthOk = false;
      try {
        const healthResult = await sendToTab(state.tabId, { action: "checkFormReady" });
        healthOk = healthResult && healthResult.formReady;
      } catch {
        healthOk = false;
      }
      if (!healthOk) {
        addLog("[Health Check] Session unhealthy — proactively re-logging in before failure.");
        // Suppress expiry detection briefly (Fix 6)
        state.loginRetryCount = 0;
        processingActive = false;
        await startLogin();
        return; // Login flow will resume processing
      }
      addLog("[Health Check] Session healthy — continuing.");
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
          processingActive = false;
          await startLogin();
          return; // Login flow will resume processing
        }

        if (sessionStatus.captcha) {
          addLog("CAPTCHA detected — please solve it in the browser tab.");
          broadcastToPopup({ type: "captchaRequired" });
          showNotification("CAPTCHA Required", "Please solve the CAPTCHA in the NCTracks browser tab to continue.");
          try {
            await sendToTab(state.tabId, { action: "waitForCaptcha" });
            addLog("CAPTCHA resolved.");
          } catch {
            addLog("CAPTCHA wait timed out — retrying...");
            continue;
          }
        }

        // Step 1: Fill form and click Check Eligibility
        // The content script fills the form, then clicks the button via setTimeout
        // and returns BEFORE the page navigates (to avoid "message channel closed")
        const fillResult = await sendToTab(state.tabId, {
          action: "fillAndCheck",
          patient: patient,
          config: state.config,
        });

        if (fillResult.status === "SESSION_EXPIRED") {
          // Page is not the eligibility form — session likely expired
          addLog("Session expired (not on eligibility form) — re-logging in...");
          broadcastToPopup({ type: "sessionExpired" });
          state.loginRetryCount = 0;
          processingActive = false;
          await startLogin();
          return; // Login flow will resume processing
        }

        if (fillResult.status === "ERROR") {
          // Form fill itself failed (e.g. field not found)
          state.results.push({
            medicaid_id: patient.medicaid_id,
            name: patientName,
            status: fillResult.status,
            emr_funding_source: patient.emr_funding_source || "",
            managing_entity: "",
            managing_entity_next: "",
            current_period: "",
            next_period: "",
            payer_changed: "",
            payer_changed_next: "",
            checked_at: new Date().toISOString(),
            notes: fillResult.notes || "",
          });
          addLog(`  Result: ERROR — ${fillResult.notes || "Form fill failed"}`);
          succeeded = true;
          break;
        }

        // Step 2: Wait for the results page to load after Check Eligibility click
        // The click triggers a page navigation — wait for the new page
        await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
        await delay(3000); // Wait for content script to inject on new page

        // Step 3: Scrape results from the new page
        // The content script will poll for up to 30s waiting for result content
        let result;
        try {
          result = await sendToTab(state.tabId, { action: "scrapeResults" });
        } catch (scrapeErr) {
          // Content script may not be ready yet — wait and retry
          addLog("  Waiting for results page to load...");
          await delay(5000);
          try {
            result = await sendToTab(state.tabId, { action: "scrapeResults" });
          } catch (retryErr) {
            result = { status: "ERROR", notes: "Could not scrape results: " + retryErr.message };
          }
        }

        // Current month entity
        const currentEntity = result.managing_entity || "";
        const currentPeriod = result.coverage_dates || "";

        addLog(`  Current month: ${currentEntity || "(none)"}${currentPeriod ? " | " + currentPeriod : ""}`);

        // Step 4: Select next month in Period Selection and scrape that too
        let nextEntity = "";
        let nextPeriod = "";
        try {
          // Ask content script to change the Period Selection dropdown
          const selectResult = await sendToTab(state.tabId, { action: "selectNextPeriod" });
          if (selectResult.status === "CHANGING") {
            nextPeriod = selectResult.nextPeriod || "";
            addLog(`  Switching to next period: ${nextPeriod}`);

            // The dropdown change triggers a page navigation — wait for it
            await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
            await delay(3000); // Wait for content script to inject

            // Scrape just the managing entity from the reloaded page
            try {
              const entityResult = await sendToTab(state.tabId, { action: "scrapeEntityOnly" });
              if (entityResult.status === "OK") {
                nextEntity = entityResult.managing_entity || "";
                if (entityResult.coverage_dates) nextPeriod = entityResult.coverage_dates;
                addLog(`  Next month: ${nextEntity || "(none)"}${nextPeriod ? " | " + nextPeriod : ""}`);
              }
            } catch (scrapeErr) {
              addLog(`  Could not scrape next period entity: ${scrapeErr.message}`);
            }
          } else if (selectResult.status === "NO_DROPDOWN") {
            // Bug 4: Retry once — refresh page, re-submit, try again
            addLog("  No Period Selection dropdown found — retrying once...");
            try {
              await navigateToEligibility();
              const retryFill = await sendToTab(state.tabId, {
                action: "fillAndCheck",
                patient: patient,
                config: state.config,
              });
              if (retryFill.submitted) {
                await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
                await delay(3000);
                const retrySelect = await sendToTab(state.tabId, { action: "selectNextPeriod" });
                if (retrySelect.status === "CHANGING") {
                  nextPeriod = retrySelect.nextPeriod || "";
                  addLog(`  Retry succeeded — switching to next period: ${nextPeriod}`);
                  await waitForTabLoad(state.tabId, TAB_LOAD_TIMEOUT_MS);
                  await delay(3000);
                  try {
                    const retryEntity = await sendToTab(state.tabId, { action: "scrapeEntityOnly" });
                    if (retryEntity.status === "OK") {
                      nextEntity = retryEntity.managing_entity || "";
                      if (retryEntity.coverage_dates) nextPeriod = retryEntity.coverage_dates;
                      addLog(`  Next month (retry): ${nextEntity || "(none)"}${nextPeriod ? " | " + nextPeriod : ""}`);
                    }
                  } catch { /* ignore */ }
                } else {
                  addLog(`  Retry still no dropdown: ${retrySelect.status}`);
                }
              }
            } catch (retryErr) {
              addLog(`  Period dropdown retry failed: ${retryErr.message}`);
            }
          } else if (selectResult.status === "NO_NEXT_PERIOD") {
            addLog("  No next month available in Period Selection.");
          } else {
            addLog(`  Next period select: ${selectResult.status} — ${selectResult.error || ""}`);
          }
        } catch (nextErr) {
          addLog(`  Could not scrape next period: ${nextErr.message}`);
        }

        const emrSource = patient.emr_funding_source || "";
        // Bug 2: Compare current month entity vs next month entity (not EMR vs NCTracks)
        let payerChangedNext = "NO";
        if (currentEntity && nextEntity) {
          payerChangedNext = currentEntity.toUpperCase() !== nextEntity.toUpperCase() ? "YES" : "NO";
        } else if (!currentEntity && !nextEntity) {
          payerChangedNext = "";
        } else {
          payerChangedNext = ""; // One is empty — can't compare
        }
        // Keep EMR vs NCTracks comparison for reference
        const payerChangedEmr = checkPayerChanged(emrSource, currentEntity);
        if (emrSource) {
          addLog(`  Payer check: EMR="${emrSource}" vs NCTracks="${currentEntity}" → ${payerChangedEmr === "YES" ? "CHANGED" : payerChangedEmr === "NO" ? "Match" : payerChangedEmr}`);
        }
        if (payerChangedNext === "YES") {
          addLog(`  PAYER CHANGE DETECTED: ${currentEntity} → ${nextEntity}`);
          // Bug 5: Fire desktop notification immediately on payer change
          showNotification("Payer Change Detected — NCTracks Verifier",
            `${result.recipient_name || patientName}: ${currentEntity} → ${nextEntity} next month.`);
        }

        // Bug 3: Classify empty entity
        let finalStatus = result.status || "UNKNOWN";
        if (!currentEntity && finalStatus !== "ERROR" && finalStatus !== "NOT FOUND") {
          const planText = (result.benefit_plan || "").toUpperCase();
          if (planText.includes("CARVE-OUT") || planText.includes("CARVE OUT") || planText === "MEDICAID") {
            finalStatus = "FFS";
            if (!currentEntity) addLog("  No managing entity — classified as FFS (Fee For Service)");
          }
        }
        if (finalStatus === "UNKNOWN" && !currentEntity && !result.coverage_dates) {
          finalStatus = "NOT FOUND";
          addLog("  No coverage data — classified as NOT FOUND");
        }

        // Validate scraped name — strip label contamination, flag truncation
        const validated = validateScrapedName(result.recipient_name, patientName);
        const resultNotes = [result.notes, validated.nameWarning].filter(Boolean).join("; ");

        state.results.push({
          medicaid_id: patient.medicaid_id,
          name: validated.name,
          status: finalStatus,
          emr_funding_source: emrSource,
          managing_entity: currentEntity || "(none)",
          managing_entity_next: nextEntity || "(none)",
          current_period: currentPeriod,
          next_period: nextPeriod,
          payer_changed: payerChangedEmr,
          payer_changed_next: payerChangedNext,
          checked_at: new Date().toISOString(),
          notes: resultNotes,
        });

        if (validated.nameWarning) addLog(`  ⚠ ${validated.nameWarning}: "${validated.name}"`);
        addLog(`  Result: ${finalStatus} — ${validated.name || ""} | Entity: ${currentEntity || "(none)"} | Next: ${nextEntity || "(none)"}${payerChangedNext === "YES" ? " | PayerChanged: YES" : ""}`);
        succeeded = true;
        break;
      } catch (err) {
        lastError = err.message;
        if (attempt < MAX_RETRIES) {
          addLog(`  Attempt ${attempt} failed: ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await delay(RETRY_DELAY_MS);

          // Navigate back to eligibility form before retrying
          try {
            await ensureTab();
            await navigateToEligibility();
          } catch (recoveryErr) {
            addLog("  Recovery failed: " + recoveryErr.message);
            break;
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
        emr_funding_source: patient.emr_funding_source || "",
        managing_entity: "",
        managing_entity_next: "",
        current_period: "",
        next_period: "",
        payer_changed: "",
        payer_changed_next: "",
        checked_at: new Date().toISOString(),
        notes: `Failed after ${MAX_RETRIES} attempts: ${lastError}`,
      });
      // Part 2: Error notification (only after all retries failed)
      showNotification("Error — NCTracks Verifier",
        `Patient ${patientName || patient.medicaid_id} (${patient.medicaid_id}) failed after retry. Manual review needed.`);
    }

    state.currentIndex++;
    saveState();
    sendProgress();

    // Navigate back to eligibility form for the next patient
    // (Check Eligibility loads a results page, so we must return to the form)
    if (state.currentIndex < state.totalPatients && !state.stopRequested) {
      await navigateToEligibility();
    }

    // Fix 5: Randomized delay between patients (2-4 seconds)
    const randomDelay = 2000 + Math.floor(Math.random() * 2000);
    await delay(randomDelay);
    processingActive = false; // Release lock before next iteration
    processNextPatient();
  } catch (err) {
    processingActive = false;
    // Catch-all for unexpected errors in processing loop
    addLog(`Unexpected error in processing loop: ${err.message}`);
    broadcastError("unknown", `Processing failed unexpectedly: ${err.message}`);
  }
}

function finishBatch(logMessage) {
  processingActive = false;
  state.status = "done";
  saveState();
  sendProgress();
  addLog(logMessage);
  // Fix 1: Report session expiry stats
  if (state.trueExpiryCount > 0 || state.falseAlarmCount > 0) {
    addLog(`Session stats: ${state.trueExpiryCount} true expiries, ${state.falseAlarmCount} false alarms recovered.`);
  }
  broadcastToPopup({ type: "complete", results: state.results });
  stopKeepalive();
}

// ─── Message Handlers ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── From NCID content script ──

  if (msg.event === "ncidPageReady") {
    addLog(`NCID page ready: ${msg.pageType} (${msg.url || "unknown URL"})`);
    if (state.status === "logging_in" && state.credentials.username) {
      // Content script is ready — send credentials immediately (with a small delay for page settle)
      setTimeout(async () => {
        try {
          await sendToTab(state.tabId, {
            action: "fillLogin",
            username: state.credentials.username,
            password: state.credentials.password,
          });
          addLog("Login credentials sent via page-ready handler.");
        } catch (err) {
          addLog("Failed to send credentials via page-ready: " + err.message);
        }
      }, 500);
    }
    // Also handle password step after page reload (NCID sometimes does full reload)
    if (msg.pageType === "password" && state.pendingPassword) {
      setTimeout(async () => {
        try {
          await sendToTab(state.tabId, {
            action: "fillLogin",
            username: state.credentials.username,
            password: state.pendingPassword,
          });
          addLog("Password sent after page reload.");
        } catch (err) {
          addLog("Failed to send password after reload: " + err.message);
        }
      }, 500);
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

    // Fix 4: Log the exact interrupted patient
    const interruptedPatient = state.patients[state.currentIndex];
    const interruptedLabel = interruptedPatient
      ? `patient ${state.currentIndex + 1}/${state.totalPatients} (${interruptedPatient.medicaid_id})`
      : "unknown";
    addLog(`MFA required — paused at ${interruptedLabel}`);

    // Set up keepalive and timeout
    startKeepalive();
    chrome.alarms.create("mfa-timeout", { delayInMinutes: MFA_TIMEOUT_MS / 60000 });

    // Try auto-fill TOTP if secret is configured
    chrome.storage.local.get(["savedTotpSecret"], async (data) => {
      const secret = (data.savedTotpSecret || "").trim();
      if (secret) {
        try {
          const code = await generateTOTP(secret);
          addLog("TOTP code generated, auto-filling MFA...");
          await sendToTab(state.tabId, { action: "fillMfa", code });
          broadcastToPopup({ type: "mfaAutoFilled" });
          return; // Don't show manual MFA prompt
        } catch (err) {
          addLog("TOTP auto-fill failed: " + err.message + " — falling back to manual.");
        }
      }
      // No TOTP secret or generation failed — prompt user
      addLog("MFA required — please complete verification in the browser tab.");
      // Fix 4: Send banner info with patient context
      broadcastToPopup({
        type: "mfaRequired",
        interruptedPatient: interruptedLabel,
        currentIndex: state.currentIndex,
        totalPatients: state.totalPatients,
      });
      showNotification("MFA Required — NCTracks Verifier",
        "Please enter your MFA code in the NCTracks tab. Automation is paused.",
        { requireInteraction: true });
    });
  }

  if (msg.event === "mfaAutoFillFailed") {
    addLog("TOTP auto-fill failed: " + (msg.reason || "unknown") + " — waiting for manual MFA.");
    broadcastToPopup({ type: "mfaRequired" });
    showNotification("MFA Required", "Auto-fill failed. Please complete MFA manually in the browser tab.");
  }

  if (msg.event === "loginComplete") {
    if (state.status !== "logging_in" && state.status !== "mfa_waiting") return true;
    addLog("Login complete!");
    state.status = "processing"; // Set immediately to prevent re-entry
    state.loginRetryCount = 0;
    state.lastLoginSuccessTime = Date.now(); // Fix 6: suppress expiry detection for 15s
    stopKeepalive();
    // Fix 4: Notify about resume
    const resumeLabel = state.patients[state.currentIndex]
      ? `Resuming from patient ${state.currentIndex + 1} of ${state.totalPatients}.`
      : "";
    broadcastToPopup({ type: "mfaCompleted", resumeLabel });
    showNotification("Login Successful — NCTracks Verifier",
      `MFA complete. ${resumeLabel}`);
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

  // ── From Passage Health EMR content script ──

  if (msg.event === "emrPageReady") {
    addLog(`EMR page ready: type=${msg.pageType}, URL=${msg.url || "unknown"}`);
  }

  // ── From NCTracks content script ──

  if (msg.event === "ncTracksPageReady") {
    // Only handle this ONCE during login — set status immediately to prevent re-entry
    if (state.status === "logging_in" || state.status === "mfa_waiting") {
      const url = msg.url || "";
      if (url.includes("nctracks.nc.gov") && !url.includes("loginAction")) {
        state.status = "processing"; // Set immediately to prevent loop
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
    addLog("Content script: " + (msg.error || "unknown"));
  }

  if (msg.event === "contentScriptLog") {
    addLog(msg.message || "");
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
      trueExpiryCount: 0,
      falseAlarmCount: 0,
      lastLoginSuccessTime: 0,
    };

    if (state.patients.length === 0) {
      sendResponse({ started: false, error: "No patients provided" });
      return true;
    }

    if (!state.credentials.username || !state.credentials.password) {
      sendResponse({ started: false, error: "Credentials are required" });
      return true;
    }

    processingActive = false; // Reset processing lock for new run
    updateBadge();
    startKeepalive();
    addLog(`Starting verification for ${state.totalPatients} patients...`);

    // Always create a dedicated tab — don't hijack the user's current tab
    startLogin();

    sendResponse({ started: true });
  }

  if (msg.action === "startFromEMR") {
    state = {
      status: "idle",
      patients: [],
      results: [],
      currentIndex: 0,
      totalPatients: 0,
      config: msg.config || {},
      credentials: msg.ncidCredentials || {},
      emrCredentials: msg.emrCredentials || {},
      tabId: null,
      log: [],
      pendingPassword: null,
      stopRequested: false,
      lastErrorType: null,
      mfaStartTime: null,
      loginRetryCount: 0,
      trueExpiryCount: 0,
      falseAlarmCount: 0,
      lastLoginSuccessTime: 0,
    };

    if (!state.emrCredentials.email || !state.emrCredentials.password) {
      sendResponse({ started: false, error: "EMR credentials are required" });
      return true;
    }

    if (!state.credentials.username || !state.credentials.password) {
      sendResponse({ started: false, error: "NCID credentials are required" });
      return true;
    }

    processingActive = false;
    updateBadge();
    startKeepalive();
    addLog("Starting EMR → NCTracks verification flow...");

    startFromEMR();

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

    // Always create a dedicated tab for login test
    startLogin();

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

  // ── Credentials Storage ──

  if (msg.action === "saveCredentials") {
    chrome.storage.local.set({
      savedUsername: msg.username,
      savedPassword: msg.password,
    });
    sendResponse({ saved: true });
  }

  if (msg.action === "saveEmrCredentials") {
    chrome.storage.local.set({
      savedEmrEmail: msg.email,
      savedEmrPassword: msg.password,
    });
    sendResponse({ saved: true });
  }

  if (msg.action === "saveTotpSecret") {
    chrome.storage.local.set({ savedTotpSecret: msg.secret });
    sendResponse({ saved: true });
  }

  if (msg.action === "loadCredentials") {
    chrome.storage.local.get(["savedUsername", "savedPassword", "savedEmrEmail", "savedEmrPassword", "savedTotpSecret"], (data) => {
      sendResponse({
        username: data.savedUsername || "",
        password: data.savedPassword || "",
        emrEmail: data.savedEmrEmail || "",
        emrPassword: data.savedEmrPassword || "",
        totpSecret: data.savedTotpSecret || "",
      });
    });
    return true; // async response
  }

  if (msg.action === "clearCredentials") {
    chrome.storage.local.remove(["savedUsername", "savedPassword"]);
    sendResponse({ cleared: true });
  }

  return true; // keep message channel open
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
