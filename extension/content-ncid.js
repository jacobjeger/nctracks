/* Content script for NCID login pages (login.myncid.nc.gov). */

(function () {
  "use strict";

  const CFG = NCTRACKS_CONFIG;

  // ─── Logging to Background ───

  function log(message) {
    try {
      chrome.runtime.sendMessage({
        event: "contentScriptLog",
        message: "[NCID] " + message,
      });
    } catch {
      console.log("[NCID]", message);
    }
  }

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
      // Try native setter first for framework-managed inputs
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (err) {
      log("fillInput failed: " + err.message);
    }
  }

  function waitFor(conditionFn, timeoutMs, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        try {
          const result = conditionFn();
          if (result) return resolve(result);
        } catch {
          // keep trying
        }
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  // ─── Page Detection ───

  function findUsernameField() {
    return findElement(CFG.USERNAME_SELECTORS);
  }

  function findPasswordField() {
    return findElement(CFG.PASSWORD_SELECTORS);
  }

  function detectPageType() {
    const u = findUsernameField();
    const p = findPasswordField();
    if (u && !p) return "username";
    if (p) return "password";
    const text = (document.body.innerText || "").toUpperCase();
    if (text.includes("VERIFICATION CODE") || text.includes("MULTI-FACTOR") ||
        text.includes("MFA") || text.includes("ONE-TIME") ||
        text.includes("AUTHENTICAT") || text.includes("SECURITY CODE") ||
        text.includes("VERIFY YOUR IDENTITY")) {
      return "mfa";
    }
    return "unknown";
  }

  function isErrorPage() {
    const t = (document.body.innerText || "").toUpperCase();
    return t.includes("INVALID USERNAME") || t.includes("INVALID PASSWORD") ||
      t.includes("ACCOUNT LOCKED") || t.includes("ACCOUNT DISABLED") ||
      t.includes("AUTHENTICATION FAILED") || t.includes("LOGIN FAILED") ||
      t.includes("ACCESS DENIED") || t.includes("INCORRECT PASSWORD");
  }

  function getLoginErrorMessage() {
    const t = (document.body.innerText || "").toUpperCase();
    if (t.includes("ACCOUNT LOCKED")) return "Account is locked.";
    if (t.includes("ACCOUNT DISABLED")) return "Account is disabled.";
    if (t.includes("INVALID USERNAME")) return "Invalid username.";
    if (t.includes("INVALID PASSWORD") || t.includes("INCORRECT PASSWORD")) return "Incorrect password.";
    if (t.includes("AUTHENTICATION FAILED") || t.includes("LOGIN FAILED")) return "Authentication failed.";
    if (t.includes("ACCESS DENIED")) return "Access denied.";

    const errorEls = document.querySelectorAll('.ping-error, .error-message, .alert-danger, [role="alert"]');
    for (const el of errorEls) {
      const text = el.textContent.trim();
      if (text.length > 5 && text.length < 200) return text;
    }
    return "Login failed — check credentials.";
  }

  function getPageDiag() {
    const inputs = document.querySelectorAll("input");
    const info = [];
    for (const inp of inputs) {
      if (inp.type === "hidden") continue;
      info.push(`${inp.type||"text"}[name=${inp.name||"?"},id=${inp.id||"?"}]`);
    }
    return info.join(", ");
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "fillLogin") {
      log("Received fillLogin command");
      handleLogin(msg.username, msg.password);
      sendResponse({ received: true });
    }
    if (msg.action === "ping") {
      sendResponse({
        alive: true,
        url: window.location.href,
        pageType: detectPageType(),
      });
    }
    return true;
  });

  // ─── Login Handler ───

  async function handleLogin(username, password) {
    try {
      await new Promise((r) => setTimeout(r, 300));

      if (isErrorPage()) {
        chrome.runtime.sendMessage({ event: "loginError", error: getLoginErrorMessage() });
        return;
      }

      const pageType = detectPageType();
      log("handleLogin pageType=" + pageType + " inputs=" + getPageDiag());

      if (pageType === "mfa") {
        log("MFA page detected");
        chrome.runtime.sendMessage({ event: "mfaRequired" });
        try {
          await waitFor(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
          }, CFG.MFA_TIMEOUT_MS, 2000);
          chrome.runtime.sendMessage({ event: "loginComplete" });
        } catch { /* timeout */ }
        return;
      }

      // ── Username step ──
      if (pageType === "username") {
        const field = findUsernameField();
        log("Filling username into " + (field ? field.name || field.id || "input" : "NULL"));
        fillInput(field, username);
        await new Promise((r) => setTimeout(r, 400));

        if (field.value !== username) {
          log("Retry fill username");
          fillInput(field, username);
          await new Promise((r) => setTimeout(r, 300));
        }
        log("Username value set: " + (field.value ? "YES" : "EMPTY"));

        // Click Next
        const nextBtn = findButtonWithText(CFG.NEXT_BUTTON_SELECTORS, "Next");
        if (nextBtn) {
          log("Clicking Next");
          nextBtn.click();
        } else {
          log("No Next button found, submitting form");
          const form = field.closest("form");
          if (form) {
            form.submit();
          } else {
            field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
          }
        }

        chrome.runtime.sendMessage({ event: "usernameSubmitted", password });

        // Wait for password field (SPA transition)
        log("Waiting for password field to appear...");
        try {
          await waitFor(() => findPasswordField(), 15000, 500);
          await new Promise((r) => setTimeout(r, 500));
          log("Password field appeared — continuing to password step");
          // Fall through to password step
        } catch {
          const newType = detectPageType();
          log("Password field did not appear. Current page type: " + newType);
          if (newType === "mfa") {
            chrome.runtime.sendMessage({ event: "mfaRequired" });
            try {
              await waitFor(() => {
                const url = window.location.href.toLowerCase();
                return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
              }, CFG.MFA_TIMEOUT_MS, 2000);
              chrome.runtime.sendMessage({ event: "loginComplete" });
            } catch { /* timeout */ }
          } else if (isErrorPage()) {
            chrome.runtime.sendMessage({ event: "loginError", error: getLoginErrorMessage() });
          } else {
            log("Page may have fully reloaded — content script will re-inject");
          }
          return;
        }
      }

      // ── Password step ──
      const pwField = findPasswordField();
      if (pwField) {
        log("Filling password into " + (pwField.name || pwField.id || "input"));
        fillInput(pwField, password);
        await new Promise((r) => setTimeout(r, 400));

        if (pwField.value !== password) {
          log("Retry fill password");
          fillInput(pwField, password);
          await new Promise((r) => setTimeout(r, 300));
        }
        log("Password value set: " + (pwField.value ? "YES" : "EMPTY"));

        // Click Sign On
        const signOnBtn = findButtonWithText(CFG.SIGN_ON_SELECTORS, ["Sign On", "Sign In", "Log In", "Submit"]);
        if (signOnBtn) {
          log("Clicking Sign On");
          signOnBtn.click();
        } else {
          log("No Sign On button, submitting form");
          const form = pwField.closest("form");
          if (form) {
            form.submit();
          } else {
            pwField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            pwField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
          }
        }

        chrome.runtime.sendMessage({ event: "passwordSubmitted" });

        await new Promise((r) => setTimeout(r, 3000));

        if (isErrorPage()) {
          chrome.runtime.sendMessage({ event: "loginError", error: getLoginErrorMessage() });
          return;
        }

        const postType = detectPageType();
        if (postType === "mfa") {
          log("MFA after password submit");
          chrome.runtime.sendMessage({ event: "mfaRequired" });
          try {
            await waitFor(() => {
              const url = window.location.href.toLowerCase();
              return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
            }, CFG.MFA_TIMEOUT_MS, 2000);
            chrome.runtime.sendMessage({ event: "loginComplete" });
          } catch { /* timeout */ }
          return;
        }

        // Wait for redirect away from NCID
        try {
          await waitFor(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
          }, 15000, 1000);
          chrome.runtime.sendMessage({ event: "loginComplete" });
        } catch {
          if (isErrorPage()) {
            chrome.runtime.sendMessage({ event: "loginError", error: getLoginErrorMessage() });
          } else {
            chrome.runtime.sendMessage({ event: "loginError", error: "Still on NCID after submitting." });
          }
        }
        return;
      }

      // Unknown
      log("Unknown page state. Inputs: " + getPageDiag());
      chrome.runtime.sendMessage({
        event: "loginError",
        error: "Could not find login fields. Page type: " + detectPageType(),
      });
    } catch (err) {
      log("handleLogin error: " + err.message);
      chrome.runtime.sendMessage({ event: "loginError", error: "Error: " + err.message });
    }
  }

  // ─── Keepalive Port ───

  function connectKeepalive() {
    try {
      const port = chrome.runtime.connect({ name: "keepalive" });
      port.onDisconnect.addListener(() => {
        setTimeout(connectKeepalive, 1000);
      });
    } catch {
      // Extension context invalidated
    }
  }
  connectKeepalive();

  // ─── Auto-request credentials on page load ───
  // When the content script loads on an NCID page, tell the background
  // so it can send credentials if a login is in progress.

  const pageType = detectPageType();
  log("Loaded on NCID page. Type: " + pageType + " URL: " + window.location.href);
  log("Visible inputs: " + getPageDiag());

  try {
    chrome.runtime.sendMessage({
      event: "ncidPageReady",
      url: window.location.href,
      pageType: pageType,
    });
  } catch {
    // Extension context may not be available
  }
})();
