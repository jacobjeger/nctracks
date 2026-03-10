/* Content script for NCID login pages (login.myncid.nc.gov). */

(function () {
  "use strict";

  const CFG = NCTRACKS_CONFIG;

  // ─── DOM Helpers ───

  function findElement(selectors) {
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
          if (!isVisible(el)) continue;
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
    const style = window.getComputedStyle(el);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.offsetParent !== null;
  }

  function fillInput(el, value) {
    try {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Also try setting via native setter for React/Angular forms
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (err) {
      logError("fillInput failed", err);
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
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout waiting for condition"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  // ─── Page Detection ───

  function isMfaPage() {
    const usernameField = findElement(CFG.USERNAME_SELECTORS.slice(0, 3));
    const passwordField = findElement(CFG.PASSWORD_SELECTORS);
    if (!usernameField && !passwordField) {
      // Double check — look for MFA indicators
      const pageText = (document.body.innerText || "").toUpperCase();
      return pageText.includes("VERIFICATION CODE") ||
        pageText.includes("MULTI-FACTOR") ||
        pageText.includes("MFA") ||
        pageText.includes("ONE-TIME") ||
        pageText.includes("AUTHENTICAT") ||
        pageText.includes("SECURITY CODE") ||
        pageText.includes("VERIFY YOUR IDENTITY");
    }
    return false;
  }

  function isUsernameStep() {
    const usernameField = findElement(CFG.USERNAME_SELECTORS.slice(0, 3));
    const passwordField = findElement(CFG.PASSWORD_SELECTORS);
    return !!usernameField && !passwordField;
  }

  function isPasswordStep() {
    return !!findElement(CFG.PASSWORD_SELECTORS);
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

    // Try to find error message elements
    const errorEls = document.querySelectorAll('.ping-error, .error-message, .alert-danger, [role="alert"]');
    for (const el of errorEls) {
      const text = el.textContent.trim();
      if (text.length > 5 && text.length < 200) return text;
    }

    return "Login failed — check credentials.";
  }

  // ─── Error Reporting ───

  function logError(context, err) {
    try {
      chrome.runtime.sendMessage({
        event: "contentScriptError",
        error: `[NCID] ${context}: ${err.message || err}`,
      });
    } catch {
      // can't report, swallow
    }
  }

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
      handleLogin(msg.username, msg.password);
      sendResponse({ received: true });
    }
    if (msg.action === "ping") {
      sendResponse({
        alive: true,
        url: window.location.href,
        pageType: isMfaPage() ? "mfa" : isUsernameStep() ? "username" : isPasswordStep() ? "password" : "unknown",
      });
    }
    return true;
  });

  // ─── Login Handler ───

  async function handleLogin(username, password) {
    try {
      // Let the page settle
      await new Promise((r) => setTimeout(r, 1500));

      // Check for error messages first (from a previous failed attempt)
      if (isErrorPage()) {
        const errorMsg = getLoginErrorMessage();
        reportError(errorMsg);
        return;
      }

      // Detect MFA
      if (isMfaPage()) {
        chrome.runtime.sendMessage({ event: "mfaRequired" });

        // Poll until URL changes away from NCID
        try {
          await waitFor(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
          }, CFG.MFA_TIMEOUT_MS, 2000);
          chrome.runtime.sendMessage({ event: "loginComplete" });
        } catch {
          // MFA timeout is handled by the background script alarm
        }
        return;
      }

      // Username step
      if (isUsernameStep()) {
        const usernameField = findElement(CFG.USERNAME_SELECTORS);
        if (!usernameField) {
          reportError("Username field not found on the page. The login page layout may have changed.");
          return;
        }

        fillInput(usernameField, username);
        await new Promise((r) => setTimeout(r, 500));

        // Verify the value was set
        if (usernameField.value !== username) {
          fillInput(usernameField, username); // retry
          await new Promise((r) => setTimeout(r, 300));
        }

        // Click Next
        const nextBtn = findButtonWithText(CFG.NEXT_BUTTON_SELECTORS, "Next");
        if (nextBtn) {
          nextBtn.click();
        } else {
          // Try form submit as fallback
          const form = usernameField.closest("form");
          if (form) {
            form.submit();
          } else {
            // Try pressing Enter
            usernameField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            usernameField.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
            usernameField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
          }
        }

        chrome.runtime.sendMessage({
          event: "usernameSubmitted",
          password: password,
        });

        // NCID is often an SPA — the page doesn't fully reload between
        // username and password steps. Wait for the password field to
        // appear, then continue filling it in the same execution.
        try {
          await waitFor(() => findElement(CFG.PASSWORD_SELECTORS), 15000, 500);
          await new Promise((r) => setTimeout(r, 500));
          // Fall through to password step below
        } catch {
          // Page might have done a full reload (content script will re-inject),
          // or it could be an MFA page. Check before giving up.
          if (isMfaPage()) {
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
          if (isErrorPage()) {
            reportError(getLoginErrorMessage());
            return;
          }
          // If no password field and no MFA, the page may have reloaded —
          // the re-injected content script will handle it.
          return;
        }
      }

      // Password step (reached directly or after username step above)
      if (isPasswordStep()) {
        const passwordField = findElement(CFG.PASSWORD_SELECTORS);
        if (!passwordField) {
          reportError("Password field not found on the page.");
          return;
        }

        fillInput(passwordField, password);
        await new Promise((r) => setTimeout(r, 500));

        // Verify
        if (passwordField.value !== password) {
          fillInput(passwordField, password);
          await new Promise((r) => setTimeout(r, 300));
        }

        // Click Sign On
        const signOnBtn = findButtonWithText(CFG.SIGN_ON_SELECTORS, ["Sign On", "Sign In", "Log In", "Submit"]);
        if (signOnBtn) {
          signOnBtn.click();
        } else {
          const form = passwordField.closest("form");
          if (form) {
            form.submit();
          } else {
            passwordField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            passwordField.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
            passwordField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
          }
        }

        chrome.runtime.sendMessage({ event: "passwordSubmitted" });

        // Wait briefly and check for error on the same page
        await new Promise((r) => setTimeout(r, 3000));
        if (isErrorPage()) {
          const errorMsg = getLoginErrorMessage();
          reportError(errorMsg);
          return;
        }

        // Check if we're still on NCID (might be MFA)
        if (isMfaPage()) {
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

        // Check if login succeeded (redirected away from NCID)
        try {
          await waitFor(() => {
            const url = window.location.href.toLowerCase();
            return !url.includes("myncid.nc.gov") && !url.includes("ncid.nc.gov");
          }, 15000, 1000);
          chrome.runtime.sendMessage({ event: "loginComplete" });
        } catch {
          // Still on NCID — check for errors
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

      // Unknown state — try to diagnose
      const pageText = (document.body.innerText || "").substring(0, 200);
      reportError(`Could not determine login step. Page content starts with: "${pageText.substring(0, 80)}..."`);
    } catch (err) {
      logError("handleLogin", err);
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

  try {
    chrome.runtime.sendMessage({
      event: "ncidPageReady",
      url: window.location.href,
      pageType: isMfaPage() ? "mfa" : isUsernameStep() ? "username" : isPasswordStep() ? "password" : "unknown",
    });
  } catch {
    // Extension context may not be available
  }
})();
