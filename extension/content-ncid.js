/* Content script for NCID login pages (login.myncid.nc.gov). */

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

  /** Set input value and dispatch change events. */
  function fillInput(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Wait for a condition to become true, polling every interval ms. */
  function waitFor(conditionFn, timeoutMs, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const result = conditionFn();
        if (result) return resolve(result);
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  /** Detect if we're on the MFA page (not username/password page). */
  function isMfaPage() {
    const usernameField = findElement(CFG.USERNAME_SELECTORS.slice(0, 3));
    const passwordField = findElement(CFG.PASSWORD_SELECTORS);
    // If neither username nor password field is visible, likely MFA
    if (!usernameField && !passwordField) return true;
    // Check for common MFA indicators
    const pageText = document.body.innerText.toUpperCase();
    return pageText.includes("VERIFICATION CODE") ||
      pageText.includes("MULTI-FACTOR") ||
      pageText.includes("MFA") ||
      pageText.includes("ONE-TIME") ||
      pageText.includes("AUTHENTICAT");
  }

  /** Detect if we're on the username step. */
  function isUsernameStep() {
    const usernameField = findElement(CFG.USERNAME_SELECTORS.slice(0, 3));
    const passwordField = findElement(CFG.PASSWORD_SELECTORS);
    return usernameField && !passwordField;
  }

  /** Detect if we're on the password step. */
  function isPasswordStep() {
    return !!findElement(CFG.PASSWORD_SELECTORS);
  }

  // Listen for messages from the background script
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "fillLogin") {
      handleLogin(msg.username, msg.password);
      sendResponse({ received: true });
    }
    if (msg.action === "ping") {
      sendResponse({ alive: true, url: window.location.href });
    }
    return true; // keep channel open for async
  });

  /** Main login handler — fills credentials step by step. */
  async function handleLogin(username, password) {
    try {
      // Small delay to let the page settle
      await new Promise((r) => setTimeout(r, 1000));

      // Detect which step we're on
      if (isMfaPage()) {
        chrome.runtime.sendMessage({ event: "mfaRequired" });
        // Poll until URL changes away from NCID
        await waitFor(() => {
          const url = window.location.href.toLowerCase();
          return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
        }, CFG.MFA_TIMEOUT_MS, 2000);
        chrome.runtime.sendMessage({ event: "loginComplete" });
        return;
      }

      if (isUsernameStep()) {
        // Fill username
        const usernameField = findElement(CFG.USERNAME_SELECTORS);
        if (!usernameField) {
          chrome.runtime.sendMessage({ event: "loginError", error: "Username field not found" });
          return;
        }
        fillInput(usernameField, username);
        await new Promise((r) => setTimeout(r, 500));

        // Click Next
        const nextBtn = findButtonWithText(CFG.NEXT_BUTTON_SELECTORS, "Next");
        if (nextBtn) {
          nextBtn.click();
        } else {
          // Try submitting the form
          const form = usernameField.closest("form");
          if (form) form.submit();
        }

        // The page will reload/redirect to password step
        // The content script will re-inject on the new page
        // Store credentials for the next step
        chrome.runtime.sendMessage({
          event: "usernameSubmitted",
          password: password,
        });
        return;
      }

      if (isPasswordStep()) {
        // Fill password
        const passwordField = findElement(CFG.PASSWORD_SELECTORS);
        if (!passwordField) {
          chrome.runtime.sendMessage({ event: "loginError", error: "Password field not found" });
          return;
        }
        fillInput(passwordField, password);
        await new Promise((r) => setTimeout(r, 500));

        // Click Sign On
        const signOnBtn = findButtonWithText(CFG.SIGN_ON_SELECTORS, ["Sign On", "Sign In", "Log In"]);
        if (signOnBtn) {
          signOnBtn.click();
        } else {
          const form = passwordField.closest("form");
          if (form) form.submit();
        }

        chrome.runtime.sendMessage({ event: "passwordSubmitted" });
        return;
      }

      // Unknown state
      chrome.runtime.sendMessage({
        event: "loginError",
        error: "Could not determine login step",
      });
    } catch (err) {
      chrome.runtime.sendMessage({
        event: "loginError",
        error: err.message,
      });
    }
  }

  // On page load, notify background that NCID page is ready
  chrome.runtime.sendMessage({ event: "ncidPageReady", url: window.location.href });
})();
