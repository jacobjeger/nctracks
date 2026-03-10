/* Content script for NCTracks pages (*.nctracks.nc.gov). */

(function () {
  "use strict";

  const CFG = NCTRACKS_CONFIG;

  // ─── DOM Helpers ───

  function findElement(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch {
        // invalid selector, skip
      }
    }
    return null;
  }

  function findButtonWithText(selectors, texts) {
    const textList = Array.isArray(texts) ? texts : [texts];
    for (const sel of selectors) {
      try {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          const elText = (el.textContent || el.value || "").trim().toUpperCase();
          for (const t of textList) {
            if (elText.includes(t.toUpperCase())) return el;
          }
        }
      } catch {
        // invalid selector, skip
      }
    }
    return null;
  }

  function fillInput(el, value) {
    try {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Try native setter for framework-managed inputs
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (err) {
      logError("fillInput", err);
    }
  }

  function setSelect(el, value) {
    if (!el || !el.options) return false;
    // Try exact match on value
    for (const opt of el.options) {
      if (opt.value === value) {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    // Try partial match on value or text
    for (const opt of el.options) {
      if (opt.value.includes(value) || opt.text.includes(value) ||
          value.includes(opt.value) || value.includes(opt.text)) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    // Try case-insensitive match
    const lowerValue = value.toLowerCase();
    for (const opt of el.options) {
      if (opt.value.toLowerCase().includes(lowerValue) || opt.text.toLowerCase().includes(lowerValue)) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function formatDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitFor(conditionFn, timeoutMs, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        try {
          const result = conditionFn();
          if (result) return resolve(result);
        } catch {
          // condition threw, keep trying
        }
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout waiting for condition"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  // ─── Page Status Detection ───

  function isSessionExpired() {
    const text = (document.body.innerText || "").toUpperCase();
    return CFG.SESSION_TIMEOUT_PHRASES.some((phrase) => text.includes(phrase));
  }

  function hasCaptcha() {
    return CFG.CAPTCHA_SELECTORS.some((sel) => {
      try { return !!document.querySelector(sel); } catch { return false; }
    });
  }

  function isErrorPage() {
    const text = (document.body.innerText || "").toUpperCase();
    return text.includes("SYSTEM ERROR") ||
      text.includes("APPLICATION ERROR") ||
      text.includes("500 INTERNAL") ||
      text.includes("503 SERVICE") ||
      text.includes("PAGE NOT FOUND") ||
      text.includes("404 NOT FOUND");
  }

  function getPageDiagnostics() {
    const url = window.location.href;
    const title = document.title;
    const bodyLength = (document.body.innerText || "").length;
    const hasForm = !!document.querySelector("form");
    const selectCount = document.querySelectorAll("select").length;
    const inputCount = document.querySelectorAll("input").length;
    return { url, title, bodyLength, hasForm, selectCount, inputCount };
  }

  // ─── Result Scraping ───

  function scrapeResults() {
    const pageText = (document.body.innerText || "").toUpperCase();
    const result = {
      status: "UNKNOWN",
      coverage_start: "",
      coverage_end: "",
      plan_name: "",
      notes: "",
    };

    // Check for error pages first
    if (isErrorPage()) {
      result.status = "ERROR";
      result.notes = "NCTracks returned a system error page";
      return result;
    }

    // Check for "not found"
    for (const phrase of CFG.NOT_FOUND_PHRASES) {
      if (pageText.includes(phrase)) {
        result.status = "NOT FOUND";
        result.notes = "Patient not found in system";
        return result;
      }
    }

    // Determine eligibility status — check most specific first
    if (pageText.includes("NOT ELIGIBLE") || pageText.includes("INELIGIBLE")) {
      result.status = "NOT ELIGIBLE";
    } else if (pageText.includes("ELIGIBLE")) {
      result.status = "ELIGIBLE";
    } else if (pageText.includes("TERMINATED")) {
      result.status = "TERMINATED";
    } else if (pageText.includes("INACTIVE")) {
      result.status = "INACTIVE";
    } else if (pageText.includes("ACTIVE")) {
      result.status = "ACTIVE";
    } else if (pageText.includes("PENDING")) {
      result.status = "PENDING";
    }

    // Try to extract coverage data from table cells
    try {
      const allTds = document.querySelectorAll("td");
      for (let i = 0; i < allTds.length; i++) {
        const cellText = (allTds[i].textContent || "").trim().toUpperCase();
        const nextTd = allTds[i + 1];
        if (!nextTd) continue;
        const nextText = (nextTd.textContent || "").trim();

        if (cellText.includes("START") && !result.coverage_start && nextText && nextText !== "N/A") {
          result.coverage_start = nextText;
        }
        if ((cellText.includes("END") || cellText.includes("TERMINATION")) && !result.coverage_end && nextText && nextText !== "N/A") {
          result.coverage_end = nextText;
        }
        if (cellText.includes("PLAN") && !result.plan_name && nextText && nextText !== "N/A") {
          result.plan_name = nextText;
        }
      }
    } catch (err) {
      logError("scrapeResults table scan", err);
    }

    // Also try span selectors
    try {
      const startSpan = document.querySelector('span[id*="startDate"], span[id*="StartDate"]');
      if (startSpan && !result.coverage_start) result.coverage_start = startSpan.textContent.trim();
      const endSpan = document.querySelector('span[id*="endDate"], span[id*="EndDate"]');
      if (endSpan && !result.coverage_end) result.coverage_end = endSpan.textContent.trim();
      const planSpan = document.querySelector('span[id*="planName"], span[id*="PlanName"]');
      if (planSpan && !result.plan_name) result.plan_name = planSpan.textContent.trim();
    } catch (err) {
      logError("scrapeResults span scan", err);
    }

    // If status is still UNKNOWN, add diagnostic info
    if (result.status === "UNKNOWN") {
      const diag = getPageDiagnostics();
      result.notes = `Could not determine status. Page: "${diag.title}", ${diag.bodyLength} chars`;
    }

    return result;
  }

  // ─── Form Fill & Submit ───

  async function fillAndCheck(patient, config) {
    const diagnostics = [];

    try {
      // Check for session/error state first
      if (isSessionExpired()) {
        return { status: "ERROR", notes: "Session expired before processing" };
      }

      if (isErrorPage()) {
        return { status: "ERROR", notes: "NCTracks error page detected" };
      }

      // Click Clear to reset form
      const clearBtn = findElement(CFG.CLEAR_SELECTORS);
      if (clearBtn) {
        clearBtn.click();
        await delay(1000);
      }

      // Set Group dropdown
      const groupSelect = findElement(CFG.GROUP_SELECTORS);
      if (groupSelect) {
        const groupValue = config.defaultGroup || CFG.DEFAULT_GROUP;
        const groupSet = setSelect(groupSelect, groupValue);
        if (!groupSet) {
          diagnostics.push(`Group "${groupValue}" not found in dropdown`);
          // List available options for troubleshooting
          const options = Array.from(groupSelect.options).map((o) => o.value).filter((v) => v);
          if (options.length > 0) {
            diagnostics.push(`Available groups: ${options.slice(0, 5).join(", ")}${options.length > 5 ? "..." : ""}`);
          }
        }
        await delay(1000); // Wait for NPI dropdown to populate after group change
      } else {
        diagnostics.push("Group dropdown not found");
      }

      // Set NPI dropdown
      const npiSelect = findElement(CFG.NPI_SELECTORS);
      if (npiSelect) {
        // Wait for options to populate (they depend on group selection)
        try {
          await waitFor(() => npiSelect.options.length > 1, 5000, 500);
        } catch {
          diagnostics.push("NPI dropdown did not populate within 5 seconds");
        }

        const npiValue = config.defaultNpi || CFG.DEFAULT_NPI;
        const npiSet = setSelect(npiSelect, npiValue);
        if (!npiSet) {
          diagnostics.push(`NPI "${npiValue}" not found in dropdown`);
          const options = Array.from(npiSelect.options).map((o) => o.value).filter((v) => v);
          if (options.length > 0) {
            diagnostics.push(`Available NPIs: ${options.slice(0, 5).join(", ")}${options.length > 5 ? "..." : ""}`);
          }
        }
        await delay(500);
      } else {
        diagnostics.push("NPI dropdown not found");
      }

      // Fill Recipient ID
      const recipientField = findElement(CFG.RECIPIENT_ID_SELECTORS);
      if (!recipientField) {
        const diag = getPageDiagnostics();
        return {
          status: "ERROR",
          notes: `Recipient ID field not found. Page has ${diag.inputCount} inputs, ${diag.selectCount} selects. ${diagnostics.join("; ")}`,
        };
      }
      fillInput(recipientField, patient.medicaid_id);
      await delay(300);

      // Verify the value was set
      if (recipientField.value !== patient.medicaid_id) {
        fillInput(recipientField, patient.medicaid_id);
        await delay(300);
        if (recipientField.value !== patient.medicaid_id) {
          diagnostics.push("Recipient ID field value could not be set reliably");
        }
      }

      // Fill Date of Service From (today)
      const today = new Date();
      const dosFromField = findElement(CFG.DOS_FROM_SELECTORS);
      if (dosFromField) {
        fillInput(dosFromField, formatDate(today));
      } else {
        diagnostics.push("DOS From field not found");
      }
      await delay(300);

      // Fill Date of Service To
      const dosToDate = new Date(today);
      dosToDate.setDate(dosToDate.getDate() + (config.dosRangeDays || CFG.DOS_RANGE_DAYS));
      const dosToField = findElement(CFG.DOS_TO_SELECTORS);
      if (dosToField) {
        fillInput(dosToField, formatDate(dosToDate));
      } else {
        diagnostics.push("DOS To field not found");
      }
      await delay(300);

      // Click Check Eligibility
      let checkBtn = findElement(CFG.CHECK_ELIGIBILITY_SELECTORS);
      if (!checkBtn) {
        checkBtn = findButtonWithText(
          ["button", "input[type='submit']", "a.btn"],
          ["Check Eligibility", "Search", "Submit", "Verify"]
        );
      }

      if (!checkBtn) {
        const diag = getPageDiagnostics();
        return {
          status: "ERROR",
          notes: `"Check Eligibility" button not found. Page: "${diag.title}". ${diagnostics.join("; ")}`,
        };
      }

      checkBtn.click();

      // Wait for results to load
      await delay(3000);

      // Wait for page to show result content or timeout
      try {
        await waitFor(() => {
          const text = (document.body.innerText || "").toUpperCase();
          return text.includes("ELIGIBLE") ||
            text.includes("NOT FOUND") ||
            text.includes("NO RECORDS") ||
            text.includes("INVALID") ||
            text.includes("ACTIVE") ||
            text.includes("TERMINATED") ||
            text.includes("ERROR") ||
            text.includes("INACTIVE") ||
            text.includes("PENDING");
        }, 20000, 1000);
      } catch {
        diagnostics.push("Result page did not show expected content within 20 seconds");
      }

      // Check if session expired during wait
      if (isSessionExpired()) {
        return { status: "ERROR", notes: "Session expired while waiting for results" };
      }

      const result = scrapeResults();

      // Append diagnostics if there were issues
      if (diagnostics.length > 0 && !result.notes) {
        result.notes = diagnostics.join("; ");
      } else if (diagnostics.length > 0) {
        result.notes += ` | ${diagnostics.join("; ")}`;
      }

      return result;
    } catch (err) {
      logError("fillAndCheck", err);
      return {
        status: "ERROR",
        notes: `Form fill error: ${err.message}. ${diagnostics.join("; ")}`,
      };
    }
  }

  // ─── Error Reporting ───

  function logError(context, err) {
    try {
      chrome.runtime.sendMessage({
        event: "contentScriptError",
        error: `[NCTracks] ${context}: ${err.message || err}`,
      });
    } catch {
      // can't report
    }
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "fillAndCheck") {
      fillAndCheck(msg.patient, msg.config)
        .then((result) => sendResponse(result))
        .catch((err) => {
          logError("fillAndCheck handler", err);
          sendResponse({ status: "ERROR", notes: "Content script error: " + err.message });
        });
      return true; // async response
    }

    if (msg.action === "checkSessionStatus") {
      try {
        const expired = isSessionExpired();
        const captcha = hasCaptcha();
        const errorPage = isErrorPage();
        const diag = getPageDiagnostics();

        sendResponse({
          expired,
          captcha,
          errorPage,
          url: window.location.href,
          diagnostics: diag,
        });
      } catch (err) {
        logError("checkSessionStatus", err);
        sendResponse({ expired: false, captcha: false, errorPage: false, error: err.message });
      }
      return true;
    }

    if (msg.action === "waitForCaptcha") {
      const startTime = Date.now();
      const poll = setInterval(() => {
        if (!hasCaptcha()) {
          clearInterval(poll);
          sendResponse({ resolved: true });
        } else if (Date.now() - startTime > CFG.CAPTCHA_TIMEOUT_MS) {
          clearInterval(poll);
          sendResponse({ resolved: false, error: "CAPTCHA timeout after " + (CFG.CAPTCHA_TIMEOUT_MS / 1000) + "s" });
        }
      }, 2000);
      return true;
    }

    if (msg.action === "ping") {
      const diag = getPageDiagnostics();
      sendResponse({
        alive: true,
        url: window.location.href,
        sessionExpired: isSessionExpired(),
        hasCaptcha: hasCaptcha(),
        diagnostics: diag,
      });
      return true;
    }

    if (msg.action === "navigateToEligibility") {
      try {
        window.location.href = CFG.ELIGIBILITY_INQUIRY_URL;
        sendResponse({ navigating: true });
      } catch (err) {
        sendResponse({ navigating: false, error: err.message });
      }
      return true;
    }
  });

  // ─── Keepalive Port ───
  // Hold a port open to the background service worker to prevent Chrome
  // from terminating it while this tab is active.

  function connectKeepalive() {
    try {
      const port = chrome.runtime.connect({ name: "keepalive" });
      port.onDisconnect.addListener(() => {
        // Service worker restarted — reconnect after a short delay
        setTimeout(connectKeepalive, 1000);
      });
    } catch {
      // Extension context may be invalidated
    }
  }
  connectKeepalive();

  // ─── Page Ready Notification ───

  try {
    chrome.runtime.sendMessage({
      event: "ncTracksPageReady",
      url: window.location.href,
      sessionExpired: isSessionExpired(),
      hasCaptcha: hasCaptcha(),
    });
  } catch {
    // Extension context may not be available
  }
})();
