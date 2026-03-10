/* Content script for NCTracks pages (*.nctracks.nc.gov). */

(function () {
  "use strict";

  const CFG = NCTRACKS_CONFIG;

  /** Find the first matching element from a list of selectors. */
  function findElement(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** Find a clickable element matching selectors that contains specific text. */
  function findButtonWithText(selectors, texts) {
    const textList = Array.isArray(texts) ? texts : [texts];
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const elText = (el.textContent || el.value || "").trim().toUpperCase();
        for (const t of textList) {
          if (elText.includes(t.toUpperCase())) return el;
        }
      }
    }
    return null;
  }

  /** Set input value and dispatch events. */
  function fillInput(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Set select dropdown value and dispatch events. */
  function setSelect(el, value) {
    // Try exact match first
    for (const opt of el.options) {
      if (opt.value === value) {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    // Try partial match on value or text
    for (const opt of el.options) {
      if (opt.value.includes(value) || opt.text.includes(value)) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  /** Format date as MM/DD/YYYY. */
  function formatDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  /** Wait for a condition, polling at interval. */
  function waitFor(conditionFn, timeoutMs, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const result = conditionFn();
        if (result) return resolve(result);
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout waiting for condition"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  /** Check if the page shows a session timeout. */
  function isSessionExpired() {
    const text = document.body.innerText.toUpperCase();
    return CFG.SESSION_TIMEOUT_PHRASES.some((phrase) => text.includes(phrase));
  }

  /** Check if a CAPTCHA is present. */
  function hasCaptcha() {
    return CFG.CAPTCHA_SELECTORS.some((sel) => !!document.querySelector(sel));
  }

  /** Scrape eligibility results from the current page. */
  function scrapeResults() {
    const pageText = document.body.innerText.toUpperCase();
    const result = {
      status: "UNKNOWN",
      coverage_start: "",
      coverage_end: "",
      plan_name: "",
      notes: "",
    };

    // Check for "not found"
    for (const phrase of CFG.NOT_FOUND_PHRASES) {
      if (pageText.includes(phrase)) {
        result.status = "NOT FOUND";
        result.notes = "Patient not found in system";
        return result;
      }
    }

    // Determine eligibility status
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
    }

    // Try to extract coverage data from table cells
    const allTds = document.querySelectorAll("td");
    for (let i = 0; i < allTds.length; i++) {
      const cellText = allTds[i].textContent.trim().toUpperCase();
      const nextTd = allTds[i + 1];
      if (!nextTd) continue;
      const nextText = nextTd.textContent.trim();

      if (cellText.includes("START") && !result.coverage_start && nextText) {
        result.coverage_start = nextText;
      }
      if (cellText.includes("END") && !result.coverage_end && nextText) {
        result.coverage_end = nextText;
      }
      if (cellText.includes("PLAN") && !result.plan_name && nextText) {
        result.plan_name = nextText;
      }
    }

    // Also try span selectors
    const startSpan = document.querySelector('span[id*="startDate"]');
    if (startSpan && !result.coverage_start) result.coverage_start = startSpan.textContent.trim();
    const endSpan = document.querySelector('span[id*="endDate"]');
    if (endSpan && !result.coverage_end) result.coverage_end = endSpan.textContent.trim();
    const planSpan = document.querySelector('span[id*="planName"]');
    if (planSpan && !result.plan_name) result.plan_name = planSpan.textContent.trim();

    return result;
  }

  /** Fill the eligibility form and click Check Eligibility. */
  async function fillAndCheck(patient, config) {
    // Click Clear to reset form
    const clearBtn = findElement(CFG.CLEAR_SELECTORS);
    if (clearBtn) {
      clearBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Set Group dropdown
    const groupSelect = findElement(CFG.GROUP_SELECTORS);
    if (groupSelect) {
      setSelect(groupSelect, config.defaultGroup || CFG.DEFAULT_GROUP);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Set NPI dropdown
    const npiSelect = findElement(CFG.NPI_SELECTORS);
    if (npiSelect) {
      setSelect(npiSelect, config.defaultNpi || CFG.DEFAULT_NPI);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Fill Recipient ID
    const recipientField = findElement(CFG.RECIPIENT_ID_SELECTORS);
    if (!recipientField) {
      return { status: "ERROR", notes: "Recipient ID field not found" };
    }
    fillInput(recipientField, patient.medicaid_id);
    await new Promise((r) => setTimeout(r, 300));

    // Fill Date of Service From (today)
    const today = new Date();
    const dosFromField = findElement(CFG.DOS_FROM_SELECTORS);
    if (dosFromField) {
      fillInput(dosFromField, formatDate(today));
    }
    await new Promise((r) => setTimeout(r, 300));

    // Fill Date of Service To (today + range)
    const dosToDate = new Date(today);
    dosToDate.setDate(dosToDate.getDate() + (config.dosRangeDays || CFG.DOS_RANGE_DAYS));
    const dosToField = findElement(CFG.DOS_TO_SELECTORS);
    if (dosToField) {
      fillInput(dosToField, formatDate(dosToDate));
    }
    await new Promise((r) => setTimeout(r, 300));

    // Click Check Eligibility
    const checkBtn = findElement(CFG.CHECK_ELIGIBILITY_SELECTORS);
    if (!checkBtn) {
      // Try button with text
      const textBtn = findButtonWithText(
        ["button", "input[type='submit']"],
        ["Check Eligibility", "Search"]
      );
      if (textBtn) {
        textBtn.click();
      } else {
        return { status: "ERROR", notes: "Check Eligibility button not found" };
      }
    } else {
      checkBtn.click();
    }

    // Wait for results to load (page update or navigation)
    await new Promise((r) => setTimeout(r, 3000));

    // Wait until page has result content or timeout
    try {
      await waitFor(() => {
        const text = document.body.innerText.toUpperCase();
        return text.includes("ELIGIBLE") ||
          text.includes("NOT FOUND") ||
          text.includes("NO RECORDS") ||
          text.includes("INVALID") ||
          text.includes("ACTIVE") ||
          text.includes("TERMINATED") ||
          text.includes("ERROR");
      }, 15000, 1000);
    } catch {
      // Timeout — try to scrape whatever is there
    }

    return scrapeResults();
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "fillAndCheck") {
      fillAndCheck(msg.patient, msg.config).then((result) => {
        sendResponse(result);
      }).catch((err) => {
        sendResponse({ status: "ERROR", notes: err.message });
      });
      return true; // async response
    }

    if (msg.action === "checkSessionStatus") {
      sendResponse({
        expired: isSessionExpired(),
        captcha: hasCaptcha(),
        url: window.location.href,
      });
      return true;
    }

    if (msg.action === "waitForCaptcha") {
      // Poll until CAPTCHA is gone
      const poll = setInterval(() => {
        if (!hasCaptcha()) {
          clearInterval(poll);
          sendResponse({ resolved: true });
        }
      }, 2000);
      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(poll);
        sendResponse({ resolved: false, error: "CAPTCHA timeout" });
      }, CFG.CAPTCHA_TIMEOUT_MS);
      return true;
    }

    if (msg.action === "ping") {
      sendResponse({ alive: true, url: window.location.href });
      return true;
    }

    if (msg.action === "navigateToEligibility") {
      window.location.href = CFG.ELIGIBILITY_INQUIRY_URL;
      sendResponse({ navigating: true });
      return true;
    }
  });

  // Notify background that NCTracks page is ready
  chrome.runtime.sendMessage({
    event: "ncTracksPageReady",
    url: window.location.href,
  });
})();
