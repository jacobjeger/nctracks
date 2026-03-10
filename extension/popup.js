/* Popup script — handles UI, file parsing, error handling, and result export. */

(function () {
  "use strict";

  // ─── DOM Elements ───
  const $ = (sel) => document.getElementById(sel);
  const connectionStatus = $("connectionStatus");
  const statusDot = $("statusDot");
  const statusLabel = $("statusLabel");
  const alertBanner = $("alertBanner");
  const alertText = $("alertText");
  const alertDismiss = $("alertDismiss");
  // EMR credentials
  const emrEmailInput = $("emrEmail");
  const emrPasswordInput = $("emrPassword");
  const saveEmrCredsCheckbox = $("saveEmrCreds");
  // NCID credentials
  const usernameInput = $("username");
  const passwordInput = $("password");
  const togglePasswordBtn = $("togglePassword");
  const totpSecretInput = $("totpSecret");
  const toggleTotpBtn = $("toggleTotp");
  const saveCredsCheckbox = $("saveCreds");
  const testLoginBtn = $("testLoginBtn");
  const fileDropZone = $("fileDropZone");
  const browseBtn = $("browseBtn");
  const fileInput = $("fileInput");
  const fileInfo = $("fileInfo");
  const fileNameSpan = $("fileName");
  const fileStats = $("fileStats");
  const fileValidation = $("fileValidation");
  const clearFileBtn = $("clearFileBtn");
  const templateBtn = $("templateBtn");
  const patientBadge = $("patientBadge");
  const tabEmr = $("tabEmr");
  const tabFile = $("tabFile");
  const tabManual = $("tabManual");
  const panelEmr = $("panelEmr");
  const panelFile = $("panelFile");
  const panelManual = $("panelManual");
  const emrStatus = $("emrStatus");
  const emrStatusText = $("emrStatusText");
  const runBtnText = $("runBtnText");
  const manualIdsInput = $("manualIds");
  const parseManualBtn = $("parseManualBtn");
  const clearManualBtn = $("clearManualBtn");
  const groupInput = $("groupId");
  const npiInput = $("npiId");
  const dosRangeInput = $("dosRange");
  const runBtn = $("runBtn");
  const stopBtn = $("stopBtn");
  const progressSection = $("progressSection");
  const progressBar = $("progressBar");
  const progressPhase = $("progressPhase");
  const progressCount = $("progressCount");
  const progressDetail = $("progressDetail");
  const resultSummary = $("resultSummary");
  const summaryEligible = $("summaryEligible");
  const summaryNotEligible = $("summaryNotEligible");
  const summaryErrors = $("summaryErrors");
  const summaryOther = $("summaryOther");
  const logOutput = $("logOutput");
  const logCount = $("logCount");
  const downloadBar = $("downloadBar");
  const downloadBtn = $("downloadBtn");
  const troubleshootSection = $("troubleshootSection");
  const troubleshootContent = $("troubleshootContent");
  const retryBtn = $("retryBtn");

  // Collapsible toggles
  const toggles = [
    { btn: $("emrCredentialsToggle"), body: $("emrCredentialsBody") },
    { btn: $("credentialsToggle"), body: $("credentialsBody") },
    { btn: $("fileToggle"), body: $("fileBody") },
    { btn: $("settingsToggle"), body: $("settingsBody") },
    { btn: $("logToggle"), body: $("logBody") },
    { btn: $("troubleshootToggle"), body: $("troubleshootBody") },
  ];

  let patients = [];
  let currentResults = [];
  let logEntryCount = 0;
  let lastError = null;
  let currentInputMode = "emr"; // "emr", "file", or "manual"

  // ─── Initialization ───

  initCollapsibleSections();
  loadSavedData();
  reconnectToState();

  // ─── Collapsible Sections ───

  function initCollapsibleSections() {
    for (const { btn, body } of toggles) {
      if (!btn || !body) continue;
      btn.addEventListener("click", () => {
        const isCollapsed = btn.classList.contains("collapsed");
        if (isCollapsed) {
          btn.classList.remove("collapsed");
          btn.setAttribute("aria-expanded", "true");
          body.classList.remove("collapsed-body");
          body.style.display = "";
        } else {
          btn.classList.add("collapsed");
          btn.setAttribute("aria-expanded", "false");
          body.classList.add("collapsed-body");
          body.style.display = "none";
        }
      });
      // Initialize state based on HTML
      if (btn.classList.contains("collapsed")) {
        body.style.display = "none";
      }
    }
  }

  // ─── Load Saved Data ───

  function loadSavedData() {
    // Load all credentials (NCID + EMR)
    chrome.runtime.sendMessage({ action: "loadCredentials" }, (response) => {
      if (chrome.runtime.lastError) {
        setConnectionStatus("error", "Disconnected");
        return;
      }
      if (response && response.username) {
        usernameInput.value = response.username;
        passwordInput.value = response.password;
      }
      if (response && response.totpSecret) {
        totpSecretInput.value = response.totpSecret;
      }
      if (response && response.emrEmail) {
        emrEmailInput.value = response.emrEmail;
        emrPasswordInput.value = response.emrPassword;
      }
      setConnectionStatus("ready", "Ready");
      updateRunButton();
    });

    // Load config
    chrome.storage.local.get(["savedGroup", "savedNpi", "savedDosRange"], (data) => {
      if (data.savedGroup) groupInput.value = data.savedGroup;
      if (data.savedNpi) npiInput.value = data.savedNpi;
      if (data.savedDosRange) dosRangeInput.value = data.savedDosRange;
    });
  }

  function reconnectToState() {
    chrome.runtime.sendMessage({ action: "getState" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.status && response.status !== "idle") {
        restoreState(response);
      }
    });
  }

  // ─── Event Listeners ───

  // Password toggle
  togglePasswordBtn.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    passwordInput.classList.toggle("password-visible", isPassword);
    togglePasswordBtn.title = isPassword ? "Hide password" : "Show password";
  });

  // TOTP secret toggle
  toggleTotpBtn.addEventListener("click", () => {
    const isPassword = totpSecretInput.type === "password";
    totpSecretInput.type = isPassword ? "text" : "password";
    toggleTotpBtn.title = isPassword ? "Hide secret" : "Show secret";
  });

  // Alert dismiss
  alertDismiss.addEventListener("click", () => hideAlert());

  // File handling
  browseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileDropZone.addEventListener("click", () => fileInput.click());

  fileDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    fileDropZone.classList.add("dragover");
  });

  fileDropZone.addEventListener("dragleave", () => {
    fileDropZone.classList.remove("dragover");
  });

  fileDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    fileDropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });

  clearFileBtn.addEventListener("click", () => {
    patients = [];
    fileInput.value = "";
    fileDropZone.style.display = "";
    fileInfo.style.display = "none";
    patientBadge.style.display = "none";
    fileValidation.style.display = "none";
    updateRunButton();
  });

  templateBtn.addEventListener("click", generateTemplate);

  // Input mode tabs
  tabEmr.addEventListener("click", () => switchInputMode("emr"));
  tabFile.addEventListener("click", () => switchInputMode("file"));
  tabManual.addEventListener("click", () => switchInputMode("manual"));

  // Manual entry
  parseManualBtn.addEventListener("click", parseManualIds);
  clearManualBtn.addEventListener("click", () => {
    manualIdsInput.value = "";
    patients = [];
    patientBadge.style.display = "none";
    updateRunButton();
  });
  manualIdsInput.addEventListener("input", () => {
    // Live-parse as user types
    parseManualIds();
  });

  // Action buttons
  runBtn.addEventListener("click", startVerification);
  stopBtn.addEventListener("click", stopVerification);
  testLoginBtn.addEventListener("click", testLogin);
  downloadBtn.addEventListener("click", downloadResults);
  retryBtn.addEventListener("click", retryLastAction);

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "log") appendLog(msg.message);
    if (msg.type === "progress") updateProgress(msg);
    if (msg.type === "complete") handleComplete(msg.results);
    if (msg.type === "mfaRequired") handleMfaRequired(msg);
    if (msg.type === "mfaCompleted") handleMfaCompleted(msg);
    if (msg.type === "mfaAutoFilled") handleMfaAutoFilled();
    if (msg.type === "captchaRequired") handleCaptchaRequired();
    if (msg.type === "error") handleError(msg);
    if (msg.type === "tabClosed") handleTabClosed();
    if (msg.type === "sessionExpired") handleSessionExpired();
    if (msg.type === "troubleshoot") showTroubleshooting(msg.issues);
    if (msg.type === "emrProgress") handleEmrProgress(msg);
  });

  // ─── File Handling ───

  function handleFile(file) {
    const validExtensions = [".xlsx", ".xls", ".csv"];
    const ext = "." + file.name.split(".").pop().toLowerCase();

    if (!validExtensions.includes(ext)) {
      showAlert("error", `Invalid file type "${ext}". Please use .xlsx, .xls, or .csv files.`);
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showAlert("error", "File is too large (max 10 MB). Please use a smaller file.");
      return;
    }

    if (file.size === 0) {
      showAlert("error", "File is empty. Please choose a file with patient data.");
      return;
    }

    parsePatientFile(file);
  }

  function parsePatientFile(file) {
    const reader = new FileReader();

    reader.onerror = () => {
      showAlert("error", "Failed to read file. Please try again.");
    };

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });

        if (!workbook.SheetNames.length) {
          showAlert("error", "The file contains no sheets. Please check the file.");
          return;
        }

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        if (rows.length === 0) {
          showAlert("warning", "The file has headers but no data rows.");
          return;
        }

        // Validate columns
        const headers = Object.keys(rows[0]).map((h) => h.trim().toUpperCase().replace(/\s+/g, "_"));

        // Check for funding_sources column (contains embedded Medicaid IDs like "Plan Name - 954658053S")
        const hasFundingSources = headers.some((h) => h === "FUNDING_SOURCES" || h === "FUNDINGSOURCES");
        const hasMedicaidId = headers.some((h) => h === "MEDICAID_ID" || h === "MEDICAIDID" || h === "MEDICAID_ID");

        if (!hasMedicaidId && !hasFundingSources) {
          showAlert("error", 'Missing required column: needs "Medicaid ID" or "funding_sources" with embedded IDs.');
          patients = [];
          updateRunButton();
          return;
        }

        // Helper: extract 9-digit+letter Medicaid IDs from a funding_sources string
        // Format: "Plan Name - 954658053S" or "Plan1 - 123456789A|Plan2 - 987654321B"
        function extractMedicaidIds(fundingStr) {
          if (!fundingStr) return [];
          const ids = new Set();
          // Match 9+ digit sequences followed by an optional letter
          const matches = fundingStr.match(/\b(\d{9,12}[A-Za-z])\b/g);
          if (matches) {
            for (const m of matches) ids.add(m);
          }
          return [...ids];
        }

        // Parse patients
        patients = [];
        const warnings = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const normalized = {};
          for (const key of Object.keys(row)) {
            normalized[key.toLowerCase().replace(/\s+/g, "_")] = String(row[key]).trim();
          }

          const name = normalized["name"] || "";
          const nameParts = name.split(/\s+/);
          const firstName = normalized["first_name"] || normalized["firstname"] || nameParts[0] || "";
          const lastName = normalized["last_name"] || normalized["lastname"] || nameParts.slice(1).join(" ") || "";
          const dob = normalized["dob"] || normalized["date_of_birth"] || "";

          // Try to get Medicaid IDs from funding_sources first
          const fundingSources = normalized["funding_sources"] || normalized["fundingsources"] || "";
          const embeddedIds = extractMedicaidIds(fundingSources);

          // Also check the medicaid_id column
          const directId = normalized["medicaid_id"] || normalized["medicaidid"] || "";

          if (embeddedIds.length > 0) {
            // Use IDs extracted from funding_sources (may have multiple per patient)
            for (const id of embeddedIds) {
              patients.push({ medicaid_id: id, first_name: firstName, last_name: lastName, dob });
            }
            if (embeddedIds.length > 1) {
              warnings.push(`Row ${i + 2}: Found ${embeddedIds.length} Medicaid IDs: ${embeddedIds.join(", ")}`);
            }
          } else if (directId && /^\d{7,12}[A-Za-z]?$/.test(directId)) {
            // Use direct Medicaid ID column if it looks like a real Medicaid ID
            patients.push({ medicaid_id: directId, first_name: firstName, last_name: lastName, dob });
          } else if (directId) {
            warnings.push(`Row ${i + 2}: Medicaid ID "${directId}" looks unusual — skipped (expected 9+ digits with optional letter)`);
          } else {
            warnings.push(`Row ${i + 2}: No Medicaid ID found — skipped`);
          }
        }

        // Deduplicate by medicaid_id
        const seen = new Set();
        patients = patients.filter((p) => {
          if (seen.has(p.medicaid_id)) return false;
          seen.add(p.medicaid_id);
          return true;
        });

        if (patients.length === 0) {
          showAlert("error", "No valid Medicaid IDs found in file. " + (warnings.length > 0 ? warnings[0] : ""));
          updateRunButton();
          return;
        }

        // Show file info
        fileDropZone.style.display = "none";
        fileInfo.style.display = "block";
        fileNameSpan.textContent = file.name;
        fileStats.textContent = `${patients.length} patients found across ${rows.length} rows`;

        patientBadge.textContent = patients.length;
        patientBadge.style.display = "inline";

        // Show warnings if any
        if (warnings.length > 0) {
          fileValidation.style.display = "block";
          const showCount = Math.min(warnings.length, 3);
          let html = warnings.slice(0, showCount).join("<br>");
          if (warnings.length > showCount) {
            html += `<br>...and ${warnings.length - showCount} more`;
          }
          fileValidation.innerHTML = html;
        } else {
          fileValidation.style.display = "none";
        }

        updateRunButton();
        showAlert("success", `Loaded ${patients.length} patients from "${file.name}"`);
      } catch (err) {
        showAlert("error", `Error parsing file: ${err.message}`);
        patients = [];
        updateRunButton();

        showTroubleshooting([
          {
            title: "File parsing failed",
            detail: "Make sure the file is a valid Excel (.xlsx) or CSV file. The first row should contain column headers.",
          },
          {
            title: "Required columns",
            detail: 'The file must have a "Medicaid ID" column. Optional: "First Name", "Last Name", "DOB".',
          },
        ]);
      }
    };

    reader.readAsArrayBuffer(file);
  }

  // ─── Input Mode Switching ───

  // inputMode is now tracked by currentInputMode (declared above)

  function switchInputMode(mode) {
    currentInputMode = mode;
    tabEmr.classList.toggle("active", mode === "emr");
    tabFile.classList.toggle("active", mode === "file");
    tabManual.classList.toggle("active", mode === "manual");
    panelEmr.style.display = mode === "emr" ? "" : "none";
    panelFile.style.display = mode === "file" ? "" : "none";
    panelManual.style.display = mode === "manual" ? "" : "none";

    // Update run button text
    if (runBtnText) {
      runBtnText.textContent = mode === "emr" ? "Pull from EMR & Verify" : "Run Verification";
    }

    // Re-parse patients from the active mode
    if (mode === "manual") {
      parseManualIds();
    }
    updateRunButton();
  }

  function parseManualIds() {
    const raw = manualIdsInput.value.trim();
    if (!raw) {
      patients = [];
      patientBadge.style.display = "none";
      updateRunButton();
      return;
    }

    // Split by newlines, commas, semicolons, or whitespace
    // Keep trailing alpha character — NC Medicaid IDs are 9 digits + 1 letter
    const ids = raw
      .split(/[\n,;\s]+/)
      .map((id) => id.trim())
      .filter((id) => /^\d{7,12}[A-Za-z]?$/.test(id));

    // Deduplicate
    const unique = [...new Set(ids)];

    patients = unique.map((id) => ({
      medicaid_id: id,
      first_name: "",
      last_name: "",
      dob: "",
    }));

    if (patients.length > 0) {
      patientBadge.textContent = patients.length;
      patientBadge.style.display = "inline";
    } else {
      patientBadge.style.display = "none";
    }

    updateRunButton();
  }

  // ─── Validation ───

  function validateBeforeRun() {
    const issues = [];

    // EMR mode: validate EMR credentials
    if (currentInputMode === "emr") {
      if (!emrEmailInput.value.trim()) {
        issues.push("Passage Health email is required");
      }
      if (!emrPasswordInput.value.trim()) {
        issues.push("Passage Health password is required");
      }
    }

    if (!usernameInput.value.trim()) {
      issues.push("NCID Username is required");
      usernameInput.closest(".input-wrapper").querySelector("input").classList.add("input-error");
    }

    if (!passwordInput.value.trim()) {
      issues.push("Password is required");
      passwordInput.closest(".input-wrapper").querySelector("input").classList.add("input-error");
    }

    if (currentInputMode !== "emr" && patients.length === 0) {
      issues.push(currentInputMode === "manual" ? "No valid Medicaid IDs entered" : "No patient file loaded");
    }

    if (!groupInput.value.trim()) {
      issues.push("Group ID is required");
    }

    if (!npiInput.value.trim()) {
      issues.push("NPI is required");
    }

    const dosRange = parseInt(dosRangeInput.value, 10);
    if (isNaN(dosRange) || dosRange < 1 || dosRange > 365) {
      issues.push("DOS range must be between 1 and 365 days");
    }

    // Clear error styling after a delay
    setTimeout(() => {
      document.querySelectorAll(".input-error").forEach((el) => el.classList.remove("input-error"));
    }, 3000);

    return issues;
  }

  function updateRunButton() {
    const hasNcidCreds = usernameInput.value.trim() && passwordInput.value.trim();

    if (currentInputMode === "emr") {
      // EMR mode: need both EMR and NCID credentials
      const hasEmrCreds = emrEmailInput.value.trim() && emrPasswordInput.value.trim();
      runBtn.disabled = !hasEmrCreds || !hasNcidCreds;
    } else {
      // File/Manual mode: need NCID credentials + patients
      const hasPatients = patients.length > 0;
      runBtn.disabled = !hasNcidCreds || !hasPatients;
    }
  }

  // Listen for input changes to update button state
  usernameInput.addEventListener("input", updateRunButton);
  passwordInput.addEventListener("input", updateRunButton);
  emrEmailInput.addEventListener("input", updateRunButton);
  emrPasswordInput.addEventListener("input", updateRunButton);

  // ─── Actions ───

  function startVerification() {
    const issues = validateBeforeRun();
    if (issues.length > 0) {
      showAlert("error", issues.join(". ") + ".");
      return;
    }

    // Save credentials if checked
    if (saveCredsCheckbox.checked) {
      chrome.runtime.sendMessage({
        action: "saveCredentials",
        username: usernameInput.value,
        password: passwordInput.value,
      });
      // Save TOTP secret if provided
      if (totpSecretInput.value.trim()) {
        chrome.runtime.sendMessage({
          action: "saveTotpSecret",
          secret: totpSecretInput.value.trim(),
        });
      }
    }

    if (saveEmrCredsCheckbox.checked && emrEmailInput.value.trim()) {
      chrome.runtime.sendMessage({
        action: "saveEmrCredentials",
        email: emrEmailInput.value,
        password: emrPasswordInput.value,
      });
    }

    // Save config
    chrome.storage.local.set({
      savedGroup: groupInput.value,
      savedNpi: npiInput.value,
      savedDosRange: dosRangeInput.value,
    });

    setRunningState(true);
    clearLog();
    hideTroubleshooting();
    hideAlert();

    progressSection.style.display = "block";
    resultSummary.style.display = "none";
    downloadBar.style.display = "none";

    const config = {
      defaultGroup: groupInput.value,
      defaultNpi: npiInput.value,
      dosRangeDays: parseInt(dosRangeInput.value, 10) || 35,
    };

    // EMR mode: use startFromEMR action
    if (currentInputMode === "emr") {
      chrome.runtime.sendMessage(
        {
          action: "startFromEMR",
          emrCredentials: {
            email: emrEmailInput.value,
            password: emrPasswordInput.value,
          },
          ncidCredentials: {
            username: usernameInput.value,
            password: passwordInput.value,
          },
          config: config,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            showAlert("error", "Could not connect to background: " + chrome.runtime.lastError.message);
            setRunningState(false);
            return;
          }
          if (response && !response.started) {
            showAlert("error", response.error || "Failed to start");
            setRunningState(false);
          }
        }
      );
      return;
    }

    // File/Manual mode: use existing startVerification action
    chrome.runtime.sendMessage(
      {
        action: "startVerification",
        patients: patients,
        credentials: {
          username: usernameInput.value,
          password: passwordInput.value,
        },
        config: config,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          showAlert("error", "Failed to start verification: " + chrome.runtime.lastError.message);
          setRunningState(false);
          showTroubleshooting([
            {
              title: "Extension communication error",
              detail: "Try reloading the extension from chrome://extensions. If the issue persists, restart Chrome.",
            },
          ]);
          return;
        }
        if (!response || !response.started) {
          showAlert("error", "Failed to start verification. Background service may not be running.");
          setRunningState(false);
        }
      }
    );
  }

  function stopVerification() {
    chrome.runtime.sendMessage({ action: "stopVerification" }, (response) => {
      if (chrome.runtime.lastError) {
        showAlert("error", "Failed to send stop signal.");
        return;
      }
    });
    stopBtn.disabled = true;
    progressPhase.textContent = "Stopping...";
    setConnectionStatus("warning", "Stopping");
  }

  function testLogin() {
    const issues = [];
    if (!usernameInput.value.trim()) issues.push("Username is required");
    if (!passwordInput.value.trim()) issues.push("Password is required");

    if (issues.length > 0) {
      showAlert("error", issues.join(". ") + ".");
      return;
    }

    if (saveCredsCheckbox.checked) {
      chrome.runtime.sendMessage({
        action: "saveCredentials",
        username: usernameInput.value,
        password: passwordInput.value,
      });
      if (totpSecretInput.value.trim()) {
        chrome.runtime.sendMessage({
          action: "saveTotpSecret",
          secret: totpSecretInput.value.trim(),
        });
      }
    }

    setRunningState(true);
    clearLog();
    hideAlert();
    hideTroubleshooting();

    chrome.runtime.sendMessage(
      {
        action: "testLogin",
        credentials: {
          username: usernameInput.value,
          password: passwordInput.value,
        },
        config: {
          defaultGroup: groupInput.value,
          defaultNpi: npiInput.value,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          showAlert("error", "Failed to start login test: " + chrome.runtime.lastError.message);
          setRunningState(false);
        }
      }
    );
  }

  function retryLastAction() {
    hideTroubleshooting();
    hideAlert();
    chrome.runtime.sendMessage({ action: "retry" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.retrying) {
        showAlert("warning", "Nothing to retry. Start a new verification.");
      }
    });
  }

  // ─── UI State Updates ───

  function setRunningState(running) {
    if (running) {
      runBtn.style.display = "none";
      stopBtn.style.display = "";
      stopBtn.disabled = false;
    } else {
      runBtn.style.display = "";
      stopBtn.style.display = "none";
    }

    testLoginBtn.disabled = running;
    browseBtn.disabled = running;
    manualIdsInput.disabled = running;
    parseManualBtn.disabled = running;
    usernameInput.disabled = running;
    passwordInput.disabled = running;
    groupInput.disabled = running;
    npiInput.disabled = running;
    dosRangeInput.disabled = running;

    if (running) {
      setConnectionStatus("processing", "Running");
    }
  }

  function setConnectionStatus(type, label) {
    statusDot.className = "status-dot " + type;
    statusLabel.textContent = label;
  }

  function showAlert(type, message) {
    alertBanner.className = "alert-banner alert-" + type;
    alertText.textContent = message;
    alertBanner.style.display = "flex";
  }

  function hideAlert() {
    alertBanner.style.display = "none";
  }

  // ─── Progress Updates ───

  function updateProgress(msg) {
    const { currentIndex, totalPatients, status, currentPatient, phase } = msg;

    if (totalPatients > 0) {
      const pct = Math.round((currentIndex / totalPatients) * 100);
      progressBar.style.width = pct + "%";
      progressCount.textContent = `${currentIndex} / ${totalPatients}`;
    } else {
      progressBar.style.width = "0%";
      progressCount.textContent = "";
    }

    if (status === "processing") {
      progressBar.classList.add("animated");
    } else {
      progressBar.classList.remove("animated");
    }

    // Update phase label
    const phaseLabels = {
      idle: "Preparing...",
      logging_in: "Logging in...",
      mfa_waiting: "Waiting for MFA...",
      processing: "Verifying patients...",
      stopping: "Stopping...",
      done: "Complete",
      error: "Error occurred",
    };
    progressPhase.textContent = phaseLabels[status] || status;

    if (currentPatient) {
      progressDetail.textContent = `Current: ${currentPatient}`;
    }

    // Update connection status
    if (status === "done") {
      setConnectionStatus("ready", "Complete");
      setRunningState(false);
    } else if (status === "error") {
      setConnectionStatus("error", "Error");
      setRunningState(false);
    } else if (status === "mfa_waiting") {
      setConnectionStatus("warning", "MFA Required");
    } else if (status === "processing" || status === "logging_in") {
      setConnectionStatus("processing", "Running");
    }

    // Update result summary
    updateResultSummary();
  }

  function updateResultSummary() {
    if (currentResults.length === 0) return;

    resultSummary.style.display = "grid";
    let eligible = 0, notEligible = 0, errors = 0, other = 0;

    for (const r of currentResults) {
      const s = (r.status || "").toUpperCase();
      if (s === "ELIGIBLE" || s === "ACTIVE") eligible++;
      else if (s === "NOT ELIGIBLE" || s === "TERMINATED" || s === "INACTIVE") notEligible++;
      else if (s === "ERROR" || s === "SKIPPED") errors++;
      else other++;
    }

    summaryEligible.textContent = eligible;
    summaryNotEligible.textContent = notEligible;
    summaryErrors.textContent = errors;
    summaryOther.textContent = other;
  }

  // ─── Log ───

  const copyLogBtn = $("copyLogBtn");
  if (copyLogBtn) {
    copyLogBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const lines = logOutput.querySelectorAll(".log-line");
      const text = Array.from(lines).map((l) => l.textContent).join("\n");
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        copyLogBtn.textContent = "Copied!";
        setTimeout(() => { copyLogBtn.textContent = "Copy Log"; }, 1500);
      });
    });
  }

  function clearLog() {
    logOutput.innerHTML = "";
    logEntryCount = 0;
    logCount.textContent = "0";
  }

  function appendLog(message) {
    // Remove the "empty" placeholder
    const empty = logOutput.querySelector(".log-empty");
    if (empty) empty.remove();

    const line = document.createElement("div");
    line.className = "log-line";

    // Parse time from message format "[HH:MM:SS AM/PM] text"
    const timeMatch = message.match(/^\[([^\]]+)\]\s*(.*)/);
    if (timeMatch) {
      const timeSpan = document.createElement("span");
      timeSpan.className = "log-time";
      timeSpan.textContent = timeMatch[1] + " ";

      const msgSpan = document.createElement("span");
      msgSpan.className = "log-msg";
      msgSpan.textContent = timeMatch[2];

      line.appendChild(timeSpan);
      line.appendChild(msgSpan);

      // Color coding
      const text = timeMatch[2].toUpperCase();
      if (text.includes("ELIGIBLE") && !text.includes("NOT ELIGIBLE") && !text.includes("INELIGIBLE")) {
        line.classList.add("log-eligible");
      } else if (text.includes("NOT ELIGIBLE") || text.includes("INELIGIBLE") || text.includes("TERMINATED")) {
        line.classList.add("log-not-eligible");
      } else if (text.includes("ERROR") || text.includes("FAILED")) {
        line.classList.add("log-error");
      } else if (text.includes("WARNING") || text.includes("CAPTCHA")) {
        line.classList.add("log-warning");
      } else if (text.includes("MFA")) {
        line.classList.add("log-mfa");
      } else if (text.includes("COMPLETE") || text.includes("SUCCESS") || text.includes("LOGIN COMPLETE")) {
        line.classList.add("log-success");
      } else if (text.includes("NAVIGATING") || text.includes("LOADING")) {
        line.classList.add("log-info");
      }
    } else {
      line.textContent = message;
    }

    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;

    logEntryCount++;
    logCount.textContent = logEntryCount;
  }

  // ─── Completion / Error Handlers ───

  function handleComplete(results) {
    currentResults = results || [];
    setRunningState(false);
    setConnectionStatus("ready", "Complete");

    progressBar.style.width = "100%";
    progressBar.classList.remove("animated");
    progressPhase.textContent = "Complete";

    updateResultSummary();
    resultSummary.style.display = "grid";

    if (currentResults.length > 0) {
      downloadBar.style.display = "block";
      // Auto-download the Excel file
      downloadResults();
    }

    const eligible = currentResults.filter((r) => r.status === "ELIGIBLE" || r.status === "ACTIVE").length;
    const errors = currentResults.filter((r) => r.status === "ERROR" || r.status === "SKIPPED").length;

    if (errors > 0) {
      showAlert("warning", `Done! ${currentResults.length} processed, ${eligible} eligible, ${errors} errors/skipped.`);
    } else {
      showAlert("success", `Done! ${currentResults.length} patients processed, ${eligible} eligible.`);
    }
  }

  let mfaCountdownInterval = null;

  function handleMfaRequired(msg) {
    setConnectionStatus("warning", "MFA Required");
    const patientInfo = msg && msg.interruptedPatient ? ` Paused at ${msg.interruptedPatient}.` : "";
    showAlert("warning", `MFA Required — please enter your code in the NCTracks tab. Automation is paused.${patientInfo}`);
    // Show a spinner/countdown in the progress section
    progressSection.style.display = "";
    progressPhase.textContent = "Waiting for MFA...";
    progressBar.style.width = "100%";
    progressBar.classList.add("animated");
    // Start a countdown timer showing elapsed time
    const mfaStart = Date.now();
    clearInterval(mfaCountdownInterval);
    mfaCountdownInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - mfaStart) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      progressDetail.textContent = `Waiting for MFA... ${mins}:${String(secs).padStart(2, "0")} elapsed`;
    }, 1000);
  }

  function handleMfaCompleted(msg) {
    clearInterval(mfaCountdownInterval);
    setConnectionStatus("processing", "Resuming");
    const resumeInfo = msg && msg.resumeLabel ? msg.resumeLabel : "Resuming verification...";
    showAlert("success", `Login successful. ${resumeInfo}`);
    progressBar.classList.remove("animated");
    // Alert auto-dismisses after 5s
    setTimeout(() => hideAlert(), 5000);
  }

  function handleMfaAutoFilled() {
    setConnectionStatus("processing", "MFA Auto-filled");
    progressPhase.textContent = "MFA auto-filled, waiting for login...";
  }

  function handleCaptchaRequired() {
    setConnectionStatus("warning", "CAPTCHA");
    showAlert("warning", "CAPTCHA detected — solve it in the browser tab to continue.");
  }

  function handleError(msg) {
    lastError = msg;
    setRunningState(false);
    setConnectionStatus("error", "Error");

    const errorMessage = msg.message || msg.error || "An unknown error occurred";
    showAlert("error", errorMessage);

    // Show troubleshooting based on error type
    const issues = diagnoseTroubleshooting(msg.errorType || "unknown", errorMessage);
    if (issues.length > 0) {
      showTroubleshooting(issues);
      retryBtn.style.display = "";
    }
  }

  function handleTabClosed() {
    setRunningState(false);
    setConnectionStatus("error", "Tab Closed");
    showAlert("error", "The browser tab was closed. Verification stopped.");
    showTroubleshooting([
      {
        title: "Tab was closed",
        detail: "The NCTracks tab was closed during verification. Click 'Run Verification' to start again.",
      },
    ]);
  }

  function handleSessionExpired() {
    showAlert("warning", "NCTracks session expired — re-logging in automatically...");
  }

  function handleEmrProgress(msg) {
    const phase = msg.phase || "";
    const count = msg.patientsFound || 0;

    if (phase === "navigating") {
      progressPhase.textContent = "Navigating to EMR reports...";
    } else if (phase === "filtering") {
      progressPhase.textContent = "Applying EMR filters...";
    } else if (phase === "scraping") {
      progressPhase.textContent = `Scraping EMR page ${msg.page || ""}...`;
      progressDetail.textContent = `${count} patients found so far`;
    } else if (phase === "complete") {
      progressPhase.textContent = `EMR scrape complete — ${count} patients found`;
      progressDetail.textContent = "Proceeding to NCTracks verification...";
    } else if (phase === "nctracks") {
      progressPhase.textContent = "Logging into NCTracks...";
      progressDetail.textContent = `${count} patients to verify`;
    }
  }

  // ─── Troubleshooting ───

  function diagnoseTroubleshooting(errorType, message) {
    const issues = [];
    const msg = (message || "").toLowerCase();

    if (errorType === "login_failed" || msg.includes("login") || msg.includes("credential")) {
      issues.push({
        title: "Login failed",
        detail: "Double-check your NCID username and password. Make sure your account is not locked.",
      });
      issues.push({
        title: "Account locked?",
        detail: "If your NCID account is locked, visit the NCID portal to unlock it before retrying.",
      });
    }

    if (errorType === "tab_error" || msg.includes("tab") || msg.includes("send message")) {
      issues.push({
        title: "Tab communication error",
        detail: "The extension lost connection to the browser tab. Make sure the NCTracks tab is still open and not showing an error page.",
      });
      issues.push({
        title: "Extension may need reload",
        detail: 'Go to chrome://extensions, find "NCTracks Eligibility Verifier", and click the reload button.',
      });
    }

    if (errorType === "session_expired" || msg.includes("session")) {
      issues.push({
        title: "Session expired",
        detail: "Your NCTracks session expired. The extension will try to re-login automatically. If it fails, start a new verification.",
      });
    }

    if (errorType === "captcha" || msg.includes("captcha")) {
      issues.push({
        title: "CAPTCHA detected",
        detail: "NCTracks is showing a CAPTCHA challenge. Switch to the browser tab to solve it, then return here.",
      });
    }

    if (errorType === "form_error" || msg.includes("field not found") || msg.includes("selector")) {
      issues.push({
        title: "Page structure changed",
        detail: "NCTracks may have updated their page layout. The form fields could not be found. Please report this issue.",
      });
    }

    if (errorType === "network" || msg.includes("timeout") || msg.includes("network") || msg.includes("fetch")) {
      issues.push({
        title: "Network issue",
        detail: "Check your internet connection. NCTracks may be temporarily unavailable or slow.",
      });
      issues.push({
        title: "NCTracks may be down",
        detail: "NCTracks has scheduled maintenance windows. Check if the site is accessible in a regular browser tab.",
      });
    }

    if (errorType === "service_worker" || msg.includes("service worker") || msg.includes("background")) {
      issues.push({
        title: "Background service stopped",
        detail: "Chrome may have stopped the background process. Reload the extension from chrome://extensions.",
      });
    }

    // Generic fallback
    if (issues.length === 0) {
      issues.push({
        title: "Unexpected error",
        detail: `Error: "${message}". Try reloading the extension or restarting the verification.`,
      });
      issues.push({
        title: "Check the log",
        detail: "Review the Activity Log above for more details about what went wrong.",
      });
    }

    return issues;
  }

  function showTroubleshooting(issues) {
    troubleshootSection.style.display = "block";
    troubleshootContent.innerHTML = issues
      .map(
        (issue) => `
      <div class="troubleshoot-item">
        <span class="troubleshoot-icon">&#9888;</span>
        <div class="troubleshoot-text">
          <div class="troubleshoot-title">${escapeHtml(issue.title)}</div>
          <div class="troubleshoot-detail">${escapeHtml(issue.detail)}</div>
        </div>
      </div>
    `
      )
      .join("");
  }

  function hideTroubleshooting() {
    troubleshootSection.style.display = "none";
    retryBtn.style.display = "none";
  }

  // ─── State Restoration ───

  function restoreState(st) {
    // Restore log entries
    if (st.log && st.log.length > 0) {
      clearLog();
      for (const entry of st.log) {
        appendLog(entry);
      }
    }

    // Restore progress
    if (st.totalPatients > 0) {
      progressSection.style.display = "block";
      updateProgress({
        currentIndex: st.currentIndex,
        totalPatients: st.totalPatients,
        status: st.status,
      });
    }

    // Restore results
    if (st.results && st.results.length > 0) {
      currentResults = st.results;
      updateResultSummary();
    }

    if (st.status === "done") {
      handleComplete(st.results);
    } else if (st.status === "error") {
      setConnectionStatus("error", "Error");
      showAlert("error", "An error occurred during the last run. Check the log for details.");
      showTroubleshooting([
        {
          title: "Previous run failed",
          detail: "Review the Activity Log for error details. You can start a new verification.",
        },
      ]);
    } else if (st.status !== "idle") {
      setRunningState(true);
      if (st.status === "mfa_waiting") {
        handleMfaRequired();
      }
    }
  }

  // ─── Template Generation ───

  function generateTemplate() {
    try {
      const wb = XLSX.utils.book_new();
      const data = [
        ["Medicaid ID", "First Name", "Last Name", "DOB"],
        ["1234567890", "John", "Doe", "01/15/1990"],
        ["0987654321", "Jane", "Smith", "03/22/1985"],
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, "Patients");
      const blob = workbookToBlob(wb);
      downloadBlob(blob, "patient_template.xlsx");
    } catch (err) {
      showAlert("error", "Failed to generate template: " + err.message);
    }
  }

  // ─── Excel Export ───

  function downloadResults() {
    if (!currentResults || currentResults.length === 0) {
      showAlert("error", "No results to download.");
      return;
    }

    try {
      const wb = XLSX.utils.book_new();
      const headers = [
        "Medicaid ID", "Name", "Status",
        "EMR Funding Source", "Insurance Type",
        "Managing Entity (Current)", "Current Period", "Payer Changed?",
        "Managing Entity (Next)", "Next Period", "Payer Changed (Next)?",
        "Checked At", "Notes",
      ];

      const wsData = [headers];
      for (const r of currentResults) {
        wsData.push([
          r.medicaid_id, r.name, r.status,
          r.emr_funding_source || "", r.insurance_type || "",
          r.managing_entity || "", r.current_period || r.coverage_dates || "", r.payer_changed || "",
          r.managing_entity_next || "", r.next_period || "", r.payer_changed_next || "",
          r.checked_at, r.notes || "",
        ]);
      }

      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Style header row
      for (let c = 0; c < headers.length; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
        if (cell) {
          cell.s = {
            font: { bold: true, color: { rgb: "FFFFFF" } },
            fill: { fgColor: { rgb: "2563EB" } },
            alignment: { horizontal: "center" },
          };
        }
      }

      // Style status cells with colors (column 2 = Status)
      for (let r = 1; r < wsData.length; r++) {
        const statusCell = ws[XLSX.utils.encode_cell({ r, c: 2 })];
        if (statusCell) {
          const val = (statusCell.v || "").toUpperCase();
          if (val === "ELIGIBLE" || val === "ACTIVE" || val === "MANAGED CARE") {
            statusCell.s = { fill: { fgColor: { rgb: "DCFCE7" } }, font: { color: { rgb: "166534" } } };
          } else if (val === "NOT ELIGIBLE" || val === "TERMINATED" || val === "ERROR") {
            statusCell.s = { fill: { fgColor: { rgb: "FEE2E2" } }, font: { color: { rgb: "991B1B" } } };
          } else if (val === "SKIPPED") {
            statusCell.s = { fill: { fgColor: { rgb: "FEF3C7" } }, font: { color: { rgb: "92400E" } } };
          }
        }

        // Style "Payer Changed?" columns (7 and 10) — highlight YES in red
        for (const pcCol of [7, 10]) {
          const pcCell = ws[XLSX.utils.encode_cell({ r, c: pcCol })];
          if (pcCell) {
            const pcVal = (pcCell.v || "").toUpperCase();
            if (pcVal === "YES") {
              pcCell.s = { fill: { fgColor: { rgb: "FEE2E2" } }, font: { bold: true, color: { rgb: "991B1B" } } };
            } else if (pcVal === "NO") {
              pcCell.s = { fill: { fgColor: { rgb: "DCFCE7" } }, font: { color: { rgb: "166534" } } };
            }
          }
        }
      }

      ws["!cols"] = [
        { wch: 14 },  // Medicaid ID
        { wch: 25 },  // Name
        { wch: 16 },  // Status
        { wch: 32 },  // EMR Funding Source
        { wch: 14 },  // Insurance Type
        { wch: 35 },  // Managing Entity (Current)
        { wch: 28 },  // Current Period
        { wch: 16 },  // Payer Changed?
        { wch: 35 },  // Managing Entity (Next)
        { wch: 28 },  // Next Period
        { wch: 18 },  // Payer Changed (Next)?
        { wch: 22 },  // Checked At
        { wch: 50 },  // Notes
      ];

      XLSX.utils.book_append_sheet(wb, ws, "Eligibility Results");

      const now = new Date();
      const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 15);
      const blob = workbookToBlob(wb);
      downloadBlob(blob, `eligibility_results_${ts}.xlsx`);

      showAlert("success", "Results downloaded successfully!");
    } catch (err) {
      showAlert("error", "Failed to generate Excel file: " + err.message);
      showTroubleshooting([
        {
          title: "Export failed",
          detail: "The results could not be exported to Excel. Try again, or check if the results data is valid.",
        },
      ]);
    }
  }

  function workbookToBlob(wb) {
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    return new Blob([wbout], { type: "application/octet-stream" });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── Utilities ───

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
})();
