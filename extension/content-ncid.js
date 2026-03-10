/* Content script for NCID login pages (login.myncid.nc.gov). */

(function () {
  "use strict";

  const CFG = NCTRACKS_CONFIG;

  // ─── Logging to Background ───

  function log(message) {
    try {
      chrome.runtime.sendMessage({
        event: "contentScriptError",
        error: `[NCID] ${message}`,
      });
    } catch {
      // can't report
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

  function findVisibleElement(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
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

  function isVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
    } catch {
      return true; // if we can't check, assume visible
    }
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
          // condition threw, keep trying
        }
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  // ─── Page Detection ───

  function getPageDiag() {
    const inputs = document.querySelectorAll("input");
    const inputInfo = [];
    for (const inp of inputs) {
      if (inp.type === "hidden") continue;
      inputInfo.push(`${inp.type||"text"}[name=${inp.name||"?"},id=${inp.id||"?"}]`);
    }
    return inputInfo.join(", ");
  }

  function findUsernameField() {
    return findElement(CFG.USERNAME_SELECTORS);
  }

  function findPasswordField() {
    return findElement(CFG.PASSWORD_SELECTORS);
  }

  function isMfaPage() {
    if (findUsernameField() || findPasswordField()) return false;
    const pageText = (document.body.innerText || "").toUpperCase();
    return pageText.includes("VERIFICATION CODE") ||
      pageText.includes("MULTI-FACTOR") ||
      pageText.includes("MFA") ||
      pageText.includes("ONE-TIME") ||
      pageText.includes("AUTHENTICAT") ||
      pageText.includes("SECURITY CODE") ||
      pageText.includes("VERIFY YOUR IDENTITY");
  }

  function isUsernameStep() {
    return !!findUsernameField() && !findPasswordField();
  }

  function isPasswordStep() {
    return !!findPasswordField();
  }

  function detectPageType() {
    if (isMfaPage()) return "mfa";
    if (isPasswordStep()) return "password";
    if (isUsernameStep()) return "username";
    return "unknown";
  }

  function isErrorPage() {
    const pageText = (document.body.innerText || "").toUpperCase();
    return pageText.includes("INVALID USERNAME") ||
      pageText.includes("INVALID PASSWORD") ||
      pageText.includes("ACCOUNT LOCKED") ||
      pageText.includes("ACCOUNT DISABLED") ||
      pageText.includes("AUTHENTICATION FAILED") ||
      pageText.includes("LOGIN FAILED") ||
      pageText.includes("ACCESS DENIED") ||
      pageText.includes("INCORRECT PASSWORD");
  }

  function getLoginErrorMessage() {
    const pageText = (document.body.innerText || "").toUpperCase();
    if (pageText.includes("ACCOUNT LOCKED")) return "Account is locked. Please unlock at the NCID portal.";
    if (pageText.includes("ACCOUNT DISABLED")) return "Account is disabled. Contact NCID support.";
    if (pageText.includes("INVALID USERNAME")) return "Invalid username. Check your NCID username.";
    if (pageText.includes("INVALID PASSWORD") || pageText.includes("INCORRECT PASSWORD")) return "Incorrect password.";
    if (pageText.includes("AUTHENTICATION FAILED") || pageText.includes("LOGIN FAILED")) return "Authentication failed.";
    if (pageText.includes("ACCESS DENIED")) return "Access denied.";

    const errorEls = document.querySelectorAll('.ping-error, .error-message, .alert-danger, [role="alert"]');
    for (const el of errorEls) {
      const text = el.textContent.trim();
      if (text.length > 5 && text.length < 200) return text;
    }

    return "Login failed — check credentials.";
  }

  // ─── Error Reporting ───

  function reportError(message) {
    try {
      chrome.runtime.sendMessage({ event: "loginError", error: message });
    } catch {
      // extension context invalidated
    }
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "fillLogin") {
      log("Received fillLogin, page type: " + detectPageType() + ", inputs: " + getPageDiag());
      handleLogin(msg.username, msg.password);
      sendResponse({ received: true });
    }
    if (msg.action === "ping") {
      sendResponse({
        alive: true,
        url: window.location.href,
        pageType: detectPageType(),
        inputs: getPageDiag(),
      });
    }
    return true;
  });

  // ─── Login Handler ───

  async function handleLogin(username, password) {
    try {
      // Brief settle
      await new Promise((r) => setTimeout(r, 500));

      // Check for error messages first (from a previous failed attempt)
      if (isErrorPage()) {
        reportError(getLoginErrorMessage());
        return;
      }

      // Detect MFA
      if (isMfaPage()) {
        log("MFA page detected");
        chrome.runtime.sendMessage({ event: "mfaRequired" });
        try {
          await waitFor(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
          }, CFG.MFA_TIMEOUT_MS, 2000);
          chrome.runtime.sendMessage({ event: "loginComplete" });
        } catch {
          // MFA timeout handled by background alarm
        }
        return;
      }

      // Username step
      const usernameField = findUsernameField();
      const passwordField = findPasswordField();

      log(`Fields found: username=${!!usernameField}, password=${!!passwordField}`);

      if (usernameField && !passwordField) {
        log("Filling username...");
        fillInput(usernameField, username);
        await new Promise((r) => setTimeout(r, 500));

        // Verify
        if (usernameField.value !== username) {
          log("Username value mismatch, retrying fill...");
          fillInput(usernameField, username);
          await new Promise((r) => setTimeout(r, 300));
        }

        log("Username filled: " + (usernameField.value ? "yes" : "EMPTY"));

        // Click Next
        const nextBtn = findButtonWithText(CFG.NEXT_BUTTON_SELECTORS, "Next");
        if (nextBtn) {
          log("Clicking Next button");
          nextBtn.click();
        } else {
          log("Next button not found, trying form submit or Enter key");
          const form = usernameField.closest("form");
          if (form) {
            form.submit();
          } else {
            usernameField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            usernameField.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
            usernameField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
          }
        }

        chrome.runtime.sendMessage({
          event: "usernameSubmitted",
          password: password,
        });

        // NCID is often an SPA — wait for password field to appear
        log("Waiting for password field...");
        try {
          await waitFor(() => findPasswordField(), 15000, 500);
          await new Promise((r) => setTimeout(r, 500));
          log("Password field appeared");
          // Fall through to password step below
        } catch {
          if (isMfaPage()) {
            log("MFA detected after username");
            chrome.runtime.sendMessage({ event: "mfaRequired" });
            try {
              await waitFor(() => {
                const url = window.location.href.toLowerCase();
                return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
              }, CFG.MFA_TIMEOUT_MS, 2000);
              chrome.runtime.sendMessage({ event: "loginComplete" });
            } catch {
              // timeout
            }
            return;
          }
          if (isErrorPage()) {
            reportError(getLoginErrorMessage());
            return;
          }
          log("Password field did not appear — page may have reloaded");
          return;
        }
      }

      // Password step (reached directly or after username step above)
      const pwField = findPasswordField();
      if (pwField) {
        log("Filling password...");
        fillInput(pwField, password);
        await new Promise((r) => setTimeout(r, 500));

        if (pwField.value !== password) {
          log("Password value mismatch, retrying fill...");
          fillInput(pwField, password);
          await new Promise((r) => setTimeout(r, 300));
        }

        log("Password filled: " + (pwField.value ? "yes" : "EMPTY"));

        // Click Sign On
        const signOnBtn = findButtonWithText(CFG.SIGN_ON_SELECTORS, ["Sign On", "Sign In", "Log In", "Submit"]);
        if (signOnBtn) {
          log("Clicking Sign On button");
          signOnBtn.click();
        } else {
          log("Sign On button not found, trying form submit or Enter key");
          const form = pwField.closest("form");
          if (form) {
            form.submit();
          } else {
            pwField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            pwField.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
            pwField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
          }
        }

        chrome.runtime.sendMessage({ event: "passwordSubmitted" });

        // Wait and check for errors
        await new Promise((r) => setTimeout(r, 3000));
        if (isErrorPage()) {
          reportError(getLoginErrorMessage());
          return;
        }

        if (isMfaPage()) {
          log("MFA detected after password");
          chrome.runtime.sendMessage({ event: "mfaRequired" });
          try {
            await waitFor(() => {
              const url = window.location.href.toLowerCase();
              return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
            }, CFG.MFA_TIMEOUT_MS, 2000);
            chrome.runtime.sendMessage({ event: "loginComplete" });
          } catch {
            // timeout
          }
          return;
        }

        // Check if login succeeded (redirected away)
        try {
          await waitFor(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
          }, 15000, 1000);
          chrome.runtime.sendMessage({ event: "loginComplete" });
        } catch {
          if (isErrorPage()) {
            reportError(getLoginErrorMessage());
          } else if (isMfaPage()) {
            chrome.runtime.sendMessage({ event: "mfaRequired" });
          } else {
            reportError("Login did not complete — still on NCID page after submitting credentials.");
          }
        }
        return;
      }

      // Unknown state
      const diag = getPageDiag();
      const bodySnippet = (document.body.innerText || "").substring(0, 100);
      reportError(`Could not detect login step. Inputs: [${diag}]. Page: "${bodySnippet}..."`);
    } catch (err) {
      log("handleLogin error: " + err.message);
      reportError("Login handler error: " + err.message);
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
      // Extension context may be invalidated
    }
  }
  connectKeepalive();

  // ─── Page Ready Notification ───

  const pageType = detectPageType();
  log("Page ready: " + pageType + ", URL: " + window.location.href + ", inputs: " + getPageDiag());

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
