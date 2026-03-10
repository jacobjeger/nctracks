/* Popup script — handles UI, file parsing, and result export. */

(function () {
  "use strict";

  // DOM elements
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");
  const saveCredsCheckbox = document.getElementById("saveCreds");
  const browseBtn = document.getElementById("browseBtn");
  const fileInput = document.getElementById("fileInput");
  const fileNameSpan = document.getElementById("fileName");
  const templateBtn = document.getElementById("templateBtn");
  const patientCountSpan = document.getElementById("patientCount");
  const groupInput = document.getElementById("groupId");
  const npiInput = document.getElementById("npiId");
  const runBtn = document.getElementById("runBtn");
  const stopBtn = document.getElementById("stopBtn");
  const testBtn = document.getElementById("testBtn");
  const progressSection = document.getElementById("progressSection");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const statusMessage = document.getElementById("statusMessage");
  const logOutput = document.getElementById("logOutput");
  const downloadBtn = document.getElementById("downloadBtn");

  let patients = [];
  let currentResults = [];

  // --- Initialization ---

  // Load saved credentials
  chrome.runtime.sendMessage({ action: "loadCredentials" }, (response) => {
    if (response && response.username) {
      usernameInput.value = response.username;
      passwordInput.value = response.password;
    }
  });

  // Load saved config
  chrome.storage.local.get(["savedGroup", "savedNpi"], (data) => {
    if (data.savedGroup) groupInput.value = data.savedGroup;
    if (data.savedNpi) npiInput.value = data.savedNpi;
  });

  // Reconnect to running state
  chrome.runtime.sendMessage({ action: "getState" }, (response) => {
    if (response && response.status !== "idle") {
      restoreState(response);
    }
  });

  // --- Event Listeners ---

  browseBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileNameSpan.textContent = file.name;
    parsePatientFile(file);
  });

  templateBtn.addEventListener("click", generateTemplate);

  runBtn.addEventListener("click", startVerification);
  stopBtn.addEventListener("click", stopVerification);
  testBtn.addEventListener("click", testLogin);
  downloadBtn.addEventListener("click", downloadResults);

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "log") {
      appendLog(msg.message);
    }
    if (msg.type === "progress") {
      updateProgress(msg.currentIndex, msg.totalPatients, msg.status);
    }
    if (msg.type === "complete") {
      currentResults = msg.results;
      onComplete();
    }
    if (msg.type === "mfaRequired") {
      setStatus("Complete MFA in the browser tab", "");
    }
    if (msg.type === "captchaRequired") {
      setStatus("Solve CAPTCHA in the browser tab", "error");
    }
  });

  // --- File Parsing ---

  function parsePatientFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        patients = [];
        for (const row of rows) {
          // Normalize column names (case-insensitive)
          const normalized = {};
          for (const key of Object.keys(row)) {
            normalized[key.toLowerCase().replace(/\s+/g, "_")] = String(row[key]).trim();
          }

          const medicaidId = normalized["medicaid_id"] || normalized["medicaidid"] || "";
          if (!medicaidId) continue;

          patients.push({
            medicaid_id: medicaidId,
            first_name: normalized["first_name"] || normalized["firstname"] || "",
            last_name: normalized["last_name"] || normalized["lastname"] || "",
            dob: normalized["dob"] || normalized["date_of_birth"] || "",
          });
        }

        patientCountSpan.textContent = `${patients.length} patients loaded`;
        runBtn.disabled = patients.length === 0;
        setStatus(`Loaded ${patients.length} patients from ${file.name}`, "success");
      } catch (err) {
        setStatus("Error reading file: " + err.message, "error");
        patients = [];
        runBtn.disabled = true;
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // --- Template Generation ---

  function generateTemplate() {
    const wb = XLSX.utils.book_new();
    const data = [
      ["Medicaid ID", "First Name", "Last Name", "DOB"],
      ["1234567890", "John", "Doe", "01/15/1990"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);

    // Set column widths
    ws["!cols"] = [
      { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 12 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Patients");
    const blob = workbookToBlob(wb);
    downloadBlob(blob, "patient_template.xlsx");
  }

  // --- Verification Control ---

  function startVerification() {
    if (patients.length === 0) {
      setStatus("No patients loaded", "error");
      return;
    }
    if (!usernameInput.value || !passwordInput.value) {
      setStatus("Enter username and password", "error");
      return;
    }

    // Save credentials if checkbox is checked
    if (saveCredsCheckbox.checked) {
      chrome.runtime.sendMessage({
        action: "saveCredentials",
        username: usernameInput.value,
        password: passwordInput.value,
      });
    }

    // Save config
    chrome.storage.local.set({
      savedGroup: groupInput.value,
      savedNpi: npiInput.value,
    });

    setRunning(true);
    logOutput.textContent = "";
    progressSection.style.display = "block";
    downloadBtn.style.display = "none";

    chrome.runtime.sendMessage({
      action: "startVerification",
      patients: patients,
      credentials: {
        username: usernameInput.value,
        password: passwordInput.value,
      },
      config: {
        defaultGroup: groupInput.value,
        defaultNpi: npiInput.value,
      },
    });
  }

  function stopVerification() {
    chrome.runtime.sendMessage({ action: "stopVerification" });
    setStatus("Stopping after current patient...", "");
    stopBtn.disabled = true;
  }

  function testLogin() {
    if (!usernameInput.value || !passwordInput.value) {
      setStatus("Enter username and password", "error");
      return;
    }

    if (saveCredsCheckbox.checked) {
      chrome.runtime.sendMessage({
        action: "saveCredentials",
        username: usernameInput.value,
        password: passwordInput.value,
      });
    }

    setRunning(true);
    logOutput.textContent = "";

    chrome.runtime.sendMessage({
      action: "testLogin",
      credentials: {
        username: usernameInput.value,
        password: passwordInput.value,
      },
      config: {
        defaultGroup: groupInput.value,
        defaultNpi: npiInput.value,
      },
    });
  }

  // --- UI Updates ---

  function setRunning(running) {
    runBtn.disabled = running;
    testBtn.disabled = running;
    stopBtn.disabled = !running;
    browseBtn.disabled = running;
    usernameInput.disabled = running;
    passwordInput.disabled = running;
  }

  function setStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = "status-message" + (type ? " " + type : "");
  }

  function updateProgress(current, total, status) {
    if (total > 0) {
      const pct = Math.round((current / total) * 100);
      progressBar.style.width = pct + "%";
      progressText.textContent = `${current} / ${total} patients`;
    }
    if (status === "done" || status === "error") {
      setRunning(false);
    }
  }

  function appendLog(message) {
    const line = document.createElement("div");
    line.textContent = message;
    if (message.includes("ELIGIBLE") && !message.includes("NOT ELIGIBLE")) {
      line.className = "log-eligible";
    } else if (message.includes("NOT ELIGIBLE") || message.includes("ERROR")) {
      line.className = "log-not-eligible";
    }
    logOutput.appendChild(line);
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  function onComplete() {
    setRunning(false);
    setStatus("Verification complete!", "success");
    downloadBtn.style.display = "block";
  }

  function restoreState(st) {
    if (st.log) {
      for (const entry of st.log) {
        appendLog(entry);
      }
    }
    if (st.totalPatients > 0) {
      progressSection.style.display = "block";
      updateProgress(st.currentIndex, st.totalPatients, st.status);
    }
    if (st.status === "done") {
      currentResults = st.results || [];
      onComplete();
    } else if (st.status !== "idle" && st.status !== "error") {
      setRunning(true);
    }
    if (st.status === "error") {
      setStatus("An error occurred — check the log", "error");
    }
    if (st.status === "mfa_waiting") {
      setStatus("Complete MFA in the browser tab", "");
      setRunning(true);
    }
  }

  // --- Excel Export ---

  function downloadResults() {
    if (!currentResults || currentResults.length === 0) {
      setStatus("No results to download", "error");
      return;
    }

    const wb = XLSX.utils.book_new();
    const headers = ["Medicaid ID", "Name", "Status", "Coverage Start",
      "Coverage End", "Plan Name", "Checked At", "Notes"];

    const wsData = [headers];
    for (const r of currentResults) {
      wsData.push([
        r.medicaid_id,
        r.name,
        r.status,
        r.coverage_start,
        r.coverage_end,
        r.plan_name,
        r.checked_at,
        r.notes,
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Style header row
    for (let c = 0; c < headers.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) {
        cell.s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: "2F5496" } },
          alignment: { horizontal: "center" },
        };
      }
    }

    // Style status cells with colors
    for (let r = 1; r < wsData.length; r++) {
      const statusCell = ws[XLSX.utils.encode_cell({ r, c: 2 })];
      if (statusCell) {
        const val = (statusCell.v || "").toUpperCase();
        if (val === "ELIGIBLE" || val === "ACTIVE") {
          statusCell.s = { fill: { fgColor: { rgb: "C6EFCE" } } };
        } else if (val === "NOT ELIGIBLE" || val === "TERMINATED" || val === "ERROR") {
          statusCell.s = { fill: { fgColor: { rgb: "FFC7CE" } } };
        }
      }
    }

    // Set column widths
    ws["!cols"] = [
      { wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 30 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Eligibility Results");

    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const filename = `eligibility_results_${ts}.xlsx`;

    const blob = workbookToBlob(wb);
    downloadBlob(blob, filename);
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
})();
