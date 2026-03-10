/* Content script for Passage Health EMR (clinical.passagehealth.com).
   Handles login, report filtering, table scraping, and pagination. */

(function () {
  "use strict";

  const CFG = (typeof NCTRACKS_CONFIG !== "undefined") ? NCTRACKS_CONFIG : (globalThis.NCTRACKS_CONFIG || {});

  // ─── Logging ───

  function log(message) {
    const msg = `EMR: ${message}`;
    console.log(`[PassageHealth] ${msg}`);
    try {
      chrome.runtime.sendMessage({ event: "contentScriptLog", message: msg });
    } catch { /* extension context may not be available */ }
  }

  function logError(context, err) {
    log(`ERROR in ${context}: ${err.message || err}`);
  }

  function logPageState() {
    const url = window.location.href;
    const title = document.title;
    const bodyLen = (document.body.innerText || "").length;
    const inputs = document.querySelectorAll("input").length;
    const buttons = document.querySelectorAll("button").length;
    const selects = document.querySelectorAll("select").length;
    const tables = document.querySelectorAll("table").length;
    log(`Page state — URL: ${url}, title: "${title}", body: ${bodyLen} chars, ${inputs} inputs, ${buttons} buttons, ${selects} selects, ${tables} tables`);
  }

  // ─── Helpers ───

  function waitFor(conditionFn, timeoutMs = 30000, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        try {
          const result = conditionFn();
          if (result) return resolve(result);
        } catch { /* ignore */ }
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout waiting for condition"));
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Set a value on an input using React-compatible approach
  function setInputValue(input, value) {
    // React uses its own value tracking; we need to use the native setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Click an element, trying multiple approaches
  function clickElement(el) {
    el.focus();
    el.click();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  // Find an element by various text-matching strategies
  function findByText(selector, textPattern) {
    const els = document.querySelectorAll(selector);
    const regex = textPattern instanceof RegExp ? textPattern : new RegExp(textPattern, "i");
    for (const el of els) {
      const text = (el.textContent || "").trim();
      if (regex.test(text)) return el;
    }
    return null;
  }

  // Find an input by its label text
  function findInputByLabel(labelText) {
    const labels = document.querySelectorAll("label");
    const regex = new RegExp(labelText, "i");
    for (const label of labels) {
      if (regex.test(label.textContent)) {
        // Try for= attribute
        if (label.htmlFor) {
          const input = document.getElementById(label.htmlFor);
          if (input) return input;
        }
        // Try child input
        const child = label.querySelector("input, select, textarea");
        if (child) return child;
        // Try next sibling
        const next = label.nextElementSibling;
        if (next && (next.tagName === "INPUT" || next.tagName === "SELECT" || next.tagName === "TEXTAREA")) return next;
        // Try parent's next input
        const parent = label.parentElement;
        if (parent) {
          const inp = parent.querySelector("input, select, textarea");
          if (inp) return inp;
        }
      }
    }
    return null;
  }

  // Find an input by placeholder text
  function findInputByPlaceholder(placeholderPattern) {
    const regex = new RegExp(placeholderPattern, "i");
    const inputs = document.querySelectorAll("input");
    for (const inp of inputs) {
      if (regex.test(inp.placeholder || "")) return inp;
    }
    return null;
  }

  // ─── Page Detection ───

  function detectPageType() {
    const url = window.location.href.toLowerCase();
    const text = (document.body.innerText || "").toUpperCase();

    if (url.includes("/dashboard/reporting/clients")) return "reports";
    if (url.includes("/dashboard/reporting")) return "reporting";
    if (url.includes("/dashboard")) return "dashboard";

    // Login page detection — look for login form indicators
    const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"], input[name="username"]');
    const hasPasswordInput = !!document.querySelector('input[type="password"]');
    if (hasEmailInput && hasPasswordInput) return "login";
    if (hasEmailInput || text.includes("SIGN IN") || text.includes("LOG IN")) return "login";

    return "unknown";
  }

  // ─── Login ───

  function performLogin(email, password) {
    log("Attempting login...");
    logPageState();

    const diagnostics = [];

    // Find email/username field
    let emailInput = document.querySelector('input[type="email"]');
    if (!emailInput) emailInput = document.querySelector('input[name="email"]');
    if (!emailInput) emailInput = document.querySelector('input[name="username"]');
    if (!emailInput) emailInput = findInputByLabel("email");
    if (!emailInput) emailInput = findInputByPlaceholder("email");
    if (!emailInput) emailInput = findInputByLabel("username");
    if (!emailInput) emailInput = findInputByPlaceholder("username");

    if (!emailInput) {
      // Fallback: find all text/email inputs
      const allInputs = document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
      diagnostics.push(`Found ${allInputs.length} text/email inputs`);
      for (const inp of allInputs) {
        diagnostics.push(`  Input: id="${inp.id}" name="${inp.name}" placeholder="${inp.placeholder}" type="${inp.type}"`);
      }
      if (allInputs.length > 0) {
        emailInput = allInputs[0];
        diagnostics.push(`Using first text input as email field: id="${emailInput.id}"`);
      }
    }

    if (!emailInput) {
      log(`Could not find email input. Diagnostics: ${diagnostics.join("; ")}`);
      return { status: "ERROR", notes: `Email input not found. ${diagnostics.join("; ")}` };
    }

    log(`Found email input: id="${emailInput.id}" name="${emailInput.name}" type="${emailInput.type}"`);

    // Find password field
    let passwordInput = document.querySelector('input[type="password"]');
    if (!passwordInput) passwordInput = findInputByLabel("password");

    if (!passwordInput) {
      log("Could not find password input");
      return { status: "ERROR", notes: "Password input not found" };
    }

    log(`Found password input: id="${passwordInput.id}" name="${passwordInput.name}"`);

    // Fill credentials
    setInputValue(emailInput, email);
    log("Email filled");

    setInputValue(passwordInput, password);
    log("Password filled");

    // Find and click submit/login button
    let loginBtn = findByText("button", /^(sign\s*in|log\s*in|login|submit)$/i);
    if (!loginBtn) loginBtn = document.querySelector('button[type="submit"]');
    if (!loginBtn) loginBtn = document.querySelector('input[type="submit"]');
    if (!loginBtn) {
      // Broader search
      loginBtn = findByText("button", /sign.*in|log.*in/i);
    }
    if (!loginBtn) {
      // Last resort: find the form and submit it
      const form = emailInput.closest("form");
      if (form) {
        log("No login button found — submitting form directly");
        // Respond before form submit (may cause navigation)
        setTimeout(() => form.submit(), 100);
        return { status: "SUBMITTING", notes: "Form submitted directly" };
      }
      log("No login button or form found");
      const allBtns = document.querySelectorAll("button");
      const btnInfo = Array.from(allBtns).map((b) => `"${(b.textContent || "").trim().substring(0, 30)}" type=${b.type}`).join("; ");
      return { status: "ERROR", notes: `Login button not found. Buttons: ${btnInfo}` };
    }

    log(`Found login button: "${(loginBtn.textContent || "").trim()}" type="${loginBtn.type}"`);

    // Respond BEFORE clicking (click may cause navigation)
    setTimeout(() => {
      clickElement(loginBtn);
      log("Login button clicked");
    }, 100);

    return { status: "SUBMITTING", notes: "Login form submitted" };
  }

  // ─── Filter Application ───

  async function applyFilters() {
    log("Applying filters on reports page...");
    logPageState();

    // Wait for the page to be interactive (React SPA may still be loading)
    await delay(2000);

    const diagnostics = [];

    // ── Status Filter ──
    log("Looking for Status filter...");

    // Strategy: Look for a dropdown/select or clickable element related to "Status"
    // React apps often use custom dropdowns, not native <select>
    let statusApplied = false;

    // Try native select first
    let statusSelect = findInputByLabel("status");
    if (statusSelect && statusSelect.tagName === "SELECT") {
      log(`Found native Status select: id="${statusSelect.id}"`);
      const activeOpt = Array.from(statusSelect.options).find((o) => /active/i.test(o.text));
      if (activeOpt) {
        statusSelect.value = activeOpt.value;
        statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
        statusApplied = true;
        log("Status set to Active via native select");
      }
    }

    if (!statusApplied) {
      // Look for a custom dropdown — common patterns: div with role="listbox", button with aria-haspopup, etc.
      // Try clicking a button/div labeled "Status" to open a dropdown
      let statusTrigger = findByText("button, [role='button'], div.select, div[class*='select'], label", /^status$/i);
      if (!statusTrigger) {
        // Look for any element that looks like a filter label
        statusTrigger = findByText("div, span, label, button", /^status/i);
      }

      if (statusTrigger) {
        log(`Found Status trigger: tag=${statusTrigger.tagName} text="${(statusTrigger.textContent || "").trim().substring(0, 40)}"`);
        clickElement(statusTrigger);
        await delay(500);

        // Look for "Active" in dropdown options
        const activeOption = findByText("li, div[role='option'], div[class*='option'], span, button", /^active$/i);
        if (activeOption) {
          clickElement(activeOption);
          statusApplied = true;
          log("Status set to Active via custom dropdown");
          await delay(500);
        } else {
          log("Could not find 'Active' option in dropdown");
          // Log visible options for debugging
          const options = document.querySelectorAll("li, div[role='option'], div[class*='option']");
          const optTexts = Array.from(options).slice(0, 20).map((o) => `"${(o.textContent || "").trim().substring(0, 40)}"`);
          log(`Visible options: ${optTexts.join(", ")}`);
        }
      } else {
        log("Could not find Status filter trigger");
        diagnostics.push("Status filter not found");
      }
    }

    // ── Funding Sources Filter ──
    log("Looking for Funding Sources filter...");

    let fundingApplied = false;
    const targetSources = CFG.PASSAGEHEALTH_FUNDING_SOURCES || [];

    // Look for the funding sources multi-select trigger.
    // IMPORTANT: The page has a table column header "FUNDING SOURCES" — we must NOT
    // match that. Look for small, filter-specific elements first (buttons, labels,
    // small divs). Avoid matching large container divs.
    let fundingTrigger = null;

    // Strategy 1: Buttons/labels with "Funding Source" text
    fundingTrigger = findByText("button, [role='button'], label", /funding\s*source/i);

    // Strategy 2: Small div/span elements (filter controls are typically compact)
    if (!fundingTrigger) {
      const candidates = document.querySelectorAll("div, span");
      for (const el of candidates) {
        const text = (el.textContent || "").trim();
        if (/^funding\s*source/i.test(text) && text.length < 50) {
          // Make sure it's a small filter element, not a big container
          fundingTrigger = el;
          log(`Found compact Funding Sources element: tag=${el.tagName} text="${text}" class="${el.className}"`);
          break;
        }
      }
    }

    // Strategy 3: Look for filter controls near the Status filter (sibling elements)
    if (!fundingTrigger) {
      // The Status filter worked — look for similar elements nearby
      const allFilterLike = document.querySelectorAll("div[class*='filter'], div[class*='select'], div[class*='dropdown'], div[class*='multi']");
      for (const el of allFilterLike) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (text.includes("funding") && text.length < 100) {
          fundingTrigger = el;
          log(`Found Funding Sources filter by class pattern: class="${el.className}"`);
          break;
        }
      }
    }

    if (fundingTrigger) {
      log(`Found Funding Sources trigger: tag=${fundingTrigger.tagName} text="${(fundingTrigger.textContent || "").trim().substring(0, 50)}" class="${(fundingTrigger.className || "").substring(0, 60)}"`);
      clickElement(fundingTrigger);
      await delay(1000);

      // Log what appeared after clicking
      const dropdownOptions = document.querySelectorAll("li, div[role='option'], div[class*='option'], [class*='menu-item'], [class*='checkbox']");
      log(`After clicking trigger: ${dropdownOptions.length} potential options visible`);
      for (let i = 0; i < Math.min(dropdownOptions.length, 15); i++) {
        log(`  Option ${i}: "${(dropdownOptions[i].textContent || "").trim().substring(0, 60)}" tag=${dropdownOptions[i].tagName} class="${(dropdownOptions[i].className || "").substring(0, 40)}"`);
      }

      let selectedCount = 0;
      for (const sourceName of targetSources) {
        // Try exact match first, then partial/contains match
        let option = findByText("li, div[role='option'], div[class*='option'], span, label, [class*='menu-item'], [class*='checkbox']", new RegExp(`^${escapeRegex(sourceName)}$`, "i"));
        if (!option) {
          // Try contains match for truncated names
          option = findByText("li, div[role='option'], div[class*='option'], span, label, [class*='menu-item'], [class*='checkbox']", new RegExp(escapeRegex(sourceName.substring(0, 20)), "i"));
        }
        if (option) {
          clickElement(option);
          selectedCount++;
          log(`Selected funding source: ${sourceName}`);
          await delay(300);
        } else {
          log(`Could not find funding source option: "${sourceName}"`);
        }
      }

      if (selectedCount > 0) {
        fundingApplied = true;
        log(`Selected ${selectedCount}/${targetSources.length} funding sources`);
      }

      // Close the dropdown by clicking elsewhere
      await delay(300);
      document.body.click();
      await delay(300);
    } else {
      log("Could not find Funding Sources filter trigger");
      // Log all small text elements for debugging
      const smallDivs = document.querySelectorAll("div, span, label, button");
      const filterLike = [];
      for (const el of smallDivs) {
        const text = (el.textContent || "").trim();
        if (text.length > 0 && text.length < 30 && /fund|source|payer|filter/i.test(text)) {
          filterLike.push(`${el.tagName}:"${text}" class="${(el.className || "").substring(0, 30)}"`);
        }
      }
      log(`Filter-like elements: ${filterLike.join("; ") || "none found"}`);
      diagnostics.push("Funding Sources filter not found");
    }

    // ── Apply/Search Button ──
    log("Looking for Apply/Search/Run button...");

    let applyBtn = findByText("button", /^(apply|search|run|filter|generate|submit)$/i);
    if (!applyBtn) applyBtn = findByText("button", /apply|search|run.*report|filter/i);
    if (!applyBtn) applyBtn = document.querySelector('button[type="submit"]');

    if (applyBtn) {
      log(`Found Apply button: "${(applyBtn.textContent || "").trim()}" type="${applyBtn.type}"`);
      clickElement(applyBtn);
      log("Apply button clicked — waiting for results...");
      await delay(3000);

      // Wait for a table to appear
      try {
        await waitFor(() => {
          const tables = document.querySelectorAll("table");
          const rows = document.querySelectorAll("table tbody tr, table tr");
          return tables.length > 0 && rows.length > 1;
        }, 30000, 1000);
        log("Table loaded after filter application");
      } catch {
        log("Timeout waiting for table to load after filter");
      }
    } else {
      log("Could not find Apply/Search button");
      const allBtns = document.querySelectorAll("button");
      const btnInfo = Array.from(allBtns).map((b) => `"${(b.textContent || "").trim().substring(0, 30)}"`).join("; ");
      log(`All buttons on page: ${btnInfo}`);
      diagnostics.push("Apply button not found");
    }

    logPageState();

    return {
      status: (statusApplied || fundingApplied) ? "OK" : "PARTIAL",
      statusApplied,
      fundingApplied,
      diagnostics: diagnostics.join("; "),
    };
  }

  // ─── Table Scraping ───

  function scrapePage() {
    log("Scraping current page...");
    logPageState();

    const patients = [];
    const diagnostics = [];

    // Find the data table
    const tables = document.querySelectorAll("table");
    log(`Found ${tables.length} tables on page`);

    if (tables.length === 0) {
      // React SPAs may not use <table> — look for list/grid patterns
      log("No tables found — looking for alternative data containers...");
      return scrapeNonTableData();
    }

    // Try each table to find the one with patient data
    for (let t = 0; t < tables.length; t++) {
      const table = tables[t];
      const headerRow = table.querySelector("thead tr, tr");
      if (!headerRow) continue;

      const headers = Array.from(headerRow.querySelectorAll("th, td")).map((c) => (c.textContent || "").trim().toUpperCase());
      log(`Table ${t}: ${headers.length} columns — [${headers.slice(0, 10).join(", ")}]`);

      // Look for columns that indicate patient data
      const colIdx = {};
      headers.forEach((h, idx) => {
        if (/^(CLIENT|PATIENT|NAME|FULL\s*NAME)$/i.test(h) || h.includes("CLIENT NAME") || h.includes("PATIENT NAME")) colIdx.name = idx;
        if (/^(FIRST\s*NAME)$/i.test(h)) colIdx.first_name = idx;
        if (/^(LAST\s*NAME)$/i.test(h)) colIdx.last_name = idx;
        if (h.includes("FUNDING") || h.includes("PAYER") || h.includes("INSURANCE")) colIdx.funding = idx;
        if (h.includes("MEDICAID") && h.includes("ID")) colIdx.medicaid_id = idx;
        if (h.includes("STATUS")) colIdx.status = idx;
      });

      log(`Column mapping: ${JSON.stringify(colIdx)}`);

      // Need at least name column to proceed
      if (colIdx.name === undefined && colIdx.first_name === undefined && colIdx.last_name === undefined) {
        diagnostics.push(`Table ${t}: No name column found`);
        continue;
      }

      // Parse data rows
      const rows = table.querySelectorAll("tbody tr, tr:not(:first-child)");
      log(`Table ${t}: ${rows.length} data rows`);

      for (let r = 0; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll("td");
        if (cells.length < 2) continue;

        const getText = (idx) => idx !== undefined && cells[idx] ? (cells[idx].textContent || "").trim() : "";

        let firstName = "", lastName = "", fullName = "";

        if (colIdx.first_name !== undefined) {
          firstName = getText(colIdx.first_name);
          lastName = getText(colIdx.last_name);
          fullName = `${firstName} ${lastName}`.trim();
        } else if (colIdx.name !== undefined) {
          fullName = getText(colIdx.name);
          // Try to split "Last, First" or "First Last"
          if (fullName.includes(",")) {
            const parts = fullName.split(",").map((s) => s.trim());
            lastName = parts[0];
            firstName = parts[1] || "";
          } else {
            const parts = fullName.split(/\s+/);
            firstName = parts[0] || "";
            lastName = parts.slice(1).join(" ");
          }
        }

        // Get funding source / payer info
        let fundingText = getText(colIdx.funding);
        let medicaidId = getText(colIdx.medicaid_id);

        // If no dedicated Medicaid ID column, extract from funding source text
        if (!medicaidId && fundingText) {
          const idMatch = fundingText.match(/\b(\d{9,12}[A-Za-z])\b/);
          if (idMatch) medicaidId = idMatch[1];
        }

        // Also try scanning all cells for a Medicaid ID if we still don't have one
        if (!medicaidId) {
          for (const cell of cells) {
            const cellText = (cell.textContent || "").trim();
            const idMatch = cellText.match(/\b(\d{9,12}[A-Za-z])\b/);
            if (idMatch) {
              medicaidId = idMatch[1];
              break;
            }
          }
        }

        // Extract the funding source name (strip out Medicaid IDs and separators)
        // EMR format: "Trillium Health Resources NC  • 954658053S" or multiple:
        // "Healthy Blue North Carolina  • 955193280NTrillium Health Resources NC  • 956669255M"
        let emrFundingSource = fundingText;
        if (emrFundingSource) {
          // Remove Medicaid IDs
          emrFundingSource = emrFundingSource.replace(/\b\d{9,12}[A-Za-z]\b/g, "").trim();
          // Remove bullet separators and dashes, then clean up whitespace
          emrFundingSource = emrFundingSource.replace(/[•·●]/g, "").replace(/[-–—]\s*$/, "").replace(/^\s*[-–—]/, "").trim();
          // Clean up multiple spaces
          emrFundingSource = emrFundingSource.replace(/\s{2,}/g, " ").trim();

          // Split on remaining payer name boundaries — after cleanup, multiple sources
          // become "Payer One  Payer Two" or similar. Try to match known sources.
          const knownSources = CFG.PASSAGEHEALTH_FUNDING_SOURCES || [];
          const matchedSource = knownSources.find((fs) => emrFundingSource.toLowerCase().includes(fs.toLowerCase()));
          if (matchedSource) {
            emrFundingSource = matchedSource;
          } else if (emrFundingSource.includes(",") || emrFundingSource.includes(";") || emrFundingSource.includes("\n")) {
            const parts = emrFundingSource.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
            emrFundingSource = parts[0];
          }
        }

        if (fullName && medicaidId) {
          patients.push({
            first_name: firstName,
            last_name: lastName,
            medicaid_id: medicaidId,
            emr_funding_source: emrFundingSource || "",
          });
          if (patients.length <= 5 || patients.length % 25 === 0) {
            log(`Row ${r + 1}: Name="${fullName}", Funding="${fundingText.substring(0, 60)}", ID=${medicaidId}, Source="${emrFundingSource}"`);
          }
        } else if (fullName) {
          diagnostics.push(`Row ${r + 1}: ${fullName} — no Medicaid ID found`);
        }
      }

      if (patients.length > 0) {
        log(`Scraped ${patients.length} patients from table ${t}`);
        break; // Found the right table
      }
    }

    if (patients.length === 0) {
      log("No patients found in any table");
      if (diagnostics.length > 0) log(`Diagnostics: ${diagnostics.join("; ")}`);
    }

    return { status: "OK", patients, diagnostics: diagnostics.join("; ") };
  }

  // Fallback: scrape data from non-table layouts (React list/card views)
  function scrapeNonTableData() {
    log("Attempting non-table scrape...");
    const patients = [];

    // Look for repeating elements that might be patient cards/rows
    const containers = document.querySelectorAll("[class*='row'], [class*='card'], [class*='item'], [class*='list-item'], [class*='client']");
    log(`Found ${containers.length} potential row/card elements`);

    // Log a sample of page structure for debugging
    const bodySnippet = (document.body.innerHTML || "").substring(0, 2000);
    log(`Page HTML snippet (first 2000 chars): ${bodySnippet.replace(/\s+/g, " ").substring(0, 500)}`);

    return { status: "NO_TABLE", patients, diagnostics: "No table found; non-table scrape found 0 patients" };
  }

  // ─── Pagination ───

  async function goToNextPage() {
    log("Looking for next page button...");

    // Common pagination patterns
    let nextBtn = null;

    // Strategy 1: aria-label "Next" or "next page"
    nextBtn = document.querySelector('button[aria-label*="next" i], a[aria-label*="next" i]');

    // Strategy 2: Button with "Next" text
    if (!nextBtn) nextBtn = findByText("button, a", /^next$/i);

    // Strategy 3: Button with ">" or "»" text
    if (!nextBtn) nextBtn = findByText("button, a", /^[>»]$/);

    // Strategy 4: Pagination controls — look for numbered pages and find the active one + 1
    if (!nextBtn) {
      const paginationContainer = document.querySelector("nav[aria-label*='pagination' i], [class*='pagination'], [class*='pager']");
      if (paginationContainer) {
        const activePage = paginationContainer.querySelector(".active, [aria-current='page'], [class*='current']");
        if (activePage) {
          nextBtn = activePage.nextElementSibling;
          if (nextBtn && nextBtn.tagName !== "BUTTON" && nextBtn.tagName !== "A") {
            nextBtn = nextBtn.querySelector("button, a");
          }
        }
      }
    }

    if (!nextBtn) {
      log("No next page button found");
      return { hasMore: false };
    }

    // Check if the button is disabled
    if (nextBtn.disabled || nextBtn.classList.contains("disabled") || nextBtn.getAttribute("aria-disabled") === "true") {
      log("Next page button is disabled — no more pages");
      return { hasMore: false };
    }

    log(`Found next page button: "${(nextBtn.textContent || "").trim()}" — clicking...`);

    // Remember current table content to detect when it changes
    const oldContent = (document.querySelector("table tbody") || document.querySelector("table") || document.body).textContent || "";

    clickElement(nextBtn);
    await delay(1000);

    // Wait for content to change
    try {
      await waitFor(() => {
        const newContent = (document.querySelector("table tbody") || document.querySelector("table") || document.body).textContent || "";
        return newContent !== oldContent;
      }, 15000, 500);
      log("Page content updated after clicking next");
    } catch {
      log("Timeout waiting for page content to change after clicking next");
    }

    await delay(1000);
    return { hasMore: true };
  }

  // ─── Utility ───

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ─── Page Ready Notification ───

  function notifyPageReady() {
    const pageType = detectPageType();
    log(`Page ready: type=${pageType}, URL=${window.location.href}`);
    try {
      chrome.runtime.sendMessage({
        event: "emrPageReady",
        pageType: pageType,
        url: window.location.href,
      });
    } catch { /* ignore */ }
  }

  // Notify on load
  notifyPageReady();

  // For SPAs: watch for URL changes and re-notify
  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      log(`SPA navigation detected: ${lastUrl}`);
      setTimeout(notifyPageReady, 1000); // Delay to let React render
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // ─── Sidebar Navigation ───

  async function navigateToReports() {
    log("Navigating to Client Reports via sidebar...");
    logPageState();

    // The Passage Health sidebar is icon-only. We need to find and click the
    // Reporting/folder icon, then click "Clients" in the submenu.
    // Strategy: look for sidebar nav links/buttons by multiple methods.

    const sidebar = document.querySelector(
      'nav, aside, [class*="sidebar"], [class*="Sidebar"], [class*="side-bar"], [class*="nav-bar"], [role="navigation"]'
    );
    if (sidebar) {
      log(`Found sidebar container: tag=${sidebar.tagName} class="${sidebar.className}"`);
    } else {
      log("No dedicated sidebar container found — searching full page");
    }

    const searchRoot = sidebar || document.body;

    // Collect all clickable items in the sidebar for diagnostics
    const allLinks = searchRoot.querySelectorAll("a, button, [role='button'], [role='menuitem'], [class*='nav-item'], [class*='menu-item']");
    log(`Sidebar has ${allLinks.length} clickable elements`);
    for (let i = 0; i < allLinks.length; i++) {
      const el = allLinks[i];
      const text = (el.textContent || "").trim().substring(0, 50);
      const href = el.getAttribute("href") || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      log(`  Sidebar item ${i}: tag=${el.tagName} text="${text}" href="${href}" aria="${ariaLabel}" title="${title}"`);
    }

    // Strategy 1: Find link/button containing "report" text (case-insensitive)
    let reportLink = null;

    // Check href first (most reliable for SPAs)
    for (const el of allLinks) {
      const href = (el.getAttribute("href") || "").toLowerCase();
      if (href.includes("report")) {
        reportLink = el;
        log(`Found reporting link by href: "${href}"`);
        break;
      }
    }

    // Check text content
    if (!reportLink) {
      reportLink = findByText("a, button, [role='menuitem'], [role='button']", /report/i);
      if (reportLink) log(`Found reporting link by text: "${(reportLink.textContent || "").trim().substring(0, 40)}"`);
    }

    // Check aria-label or title
    if (!reportLink) {
      for (const el of allLinks) {
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        if (ariaLabel.includes("report") || title.includes("report")) {
          reportLink = el;
          log(`Found reporting link by aria/title: aria="${ariaLabel}" title="${title}"`);
          break;
        }
      }
    }

    // Strategy 2: Look for an SVG icon that might represent reports/folder
    // In icon-only sidebars, the clickable element may wrap an SVG with no text
    if (!reportLink) {
      log("No text-based reporting link found — trying icon-based approach...");
      // Look for links with folder/chart/report-related SVG paths or classes
      for (const el of allLinks) {
        const svg = el.querySelector("svg");
        if (svg) {
          const svgClass = (svg.getAttribute("class") || "").toLowerCase();
          const svgContent = (svg.innerHTML || "").toLowerCase();
          if (svgClass.includes("report") || svgClass.includes("folder") || svgClass.includes("chart") ||
              svgContent.includes("report") || svgContent.includes("folder")) {
            reportLink = el;
            log(`Found reporting link by SVG content/class`);
            break;
          }
        }
      }
    }

    // Strategy 3: If still not found, try clicking sidebar items one by one
    // to see if a submenu with "Report" or "Client" appears
    if (!reportLink) {
      log("Trying sequential sidebar item clicks to find Reporting...");
      for (let i = 0; i < allLinks.length; i++) {
        const el = allLinks[i];
        // Skip obvious non-report items (settings, help, logout, etc.)
        const text = (el.textContent || "").trim().toLowerCase();
        const href = (el.getAttribute("href") || "").toLowerCase();
        if (text.includes("setting") || text.includes("help") || text.includes("logout") ||
            text.includes("sign out") || href.includes("setting") || href.includes("logout")) {
          continue;
        }

        clickElement(el);
        await delay(1000);

        // Check if "reporting" or "clients" submenu appeared
        const submenuCheck = findByText("a, button, span, li, [role='menuitem']", /report|client/i);
        if (submenuCheck) {
          log(`Clicking sidebar item ${i} revealed submenu with: "${(submenuCheck.textContent || "").trim().substring(0, 40)}"`);
          reportLink = submenuCheck;
          break;
        }

        // Check if URL changed to something with "report"
        if (window.location.href.toLowerCase().includes("report")) {
          log(`Sidebar item ${i} navigated to reports URL: ${window.location.href}`);
          reportLink = null; // Already navigated
          break;
        }
      }
    }

    if (!reportLink && !window.location.href.toLowerCase().includes("report")) {
      log("Could not find Reporting navigation item anywhere");
      return { status: "ERROR", notes: "Could not find Reporting in sidebar navigation" };
    }

    // Click the Reporting link
    if (reportLink) {
      log(`Clicking Reporting link: "${(reportLink.textContent || "").trim().substring(0, 40)}"`);
      clickElement(reportLink);
      await delay(2000);
      log(`After clicking Reporting — URL: ${window.location.href}`);
    }

    // Check if we need to click a "Clients" sub-item
    // We might already be on /dashboard/reporting/clients, or need a second click
    if (!window.location.href.toLowerCase().includes("reporting/clients")) {
      log("Looking for 'Clients' sub-navigation item...");

      // Wait a moment for submenu to render
      await delay(1000);

      let clientsLink = null;

      // Find a link to clients
      clientsLink = findByText("a, button, [role='menuitem'], [role='button'], li", /^clients?$/i);
      if (!clientsLink) {
        // Broader search
        clientsLink = findByText("a, button, [role='menuitem'], span", /client/i);
      }

      // Check href
      if (!clientsLink) {
        const links = document.querySelectorAll("a");
        for (const link of links) {
          const href = (link.getAttribute("href") || "").toLowerCase();
          if (href.includes("reporting/clients") || href.includes("report") && href.includes("client")) {
            clientsLink = link;
            log(`Found clients link by href: "${href}"`);
            break;
          }
        }
      }

      if (clientsLink) {
        log(`Clicking Clients link: "${(clientsLink.textContent || "").trim().substring(0, 40)}"`);
        clickElement(clientsLink);
        await delay(2000);
        log(`After clicking Clients — URL: ${window.location.href}`);
      } else {
        log("Could not find 'Clients' sub-item — may already be on the right page or need different navigation");
        // Log all visible links for debugging
        const visLinks = document.querySelectorAll("a");
        for (let i = 0; i < Math.min(visLinks.length, 30); i++) {
          const l = visLinks[i];
          log(`  Link ${i}: text="${(l.textContent || "").trim().substring(0, 50)}" href="${l.getAttribute("href") || ""}"`);
        }
      }
    }

    // Wait for reports page to fully load
    log("Waiting for reports page to render...");
    await delay(2000);

    // Check if we're on the reports page
    const finalUrl = window.location.href;
    const pageType = detectPageType();
    logPageState();

    if (pageType === "reports" || finalUrl.toLowerCase().includes("report")) {
      log(`Successfully navigated to reports page: ${finalUrl}`);
      return { status: "OK", url: finalUrl, pageType };
    }

    log(`Navigation may not have reached reports page. Current: ${finalUrl}, type: ${pageType}`);
    return { status: "PARTIAL", url: finalUrl, pageType, notes: "May not be on the correct reports page" };
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.action === "emrCheckPage") {
      const pageType = detectPageType();
      logPageState();
      sendResponse({
        pageType,
        url: window.location.href,
        title: document.title,
      });
      return true;
    }

    if (msg.action === "emrLogin") {
      log("Received emrLogin command");
      const result = performLogin(msg.email, msg.password);
      sendResponse(result);
      return true;
    }

    if (msg.action === "emrNavigateToReports") {
      log("Received emrNavigateToReports command");
      navigateToReports()
        .then((result) => sendResponse(result))
        .catch((err) => {
          logError("emrNavigateToReports", err);
          sendResponse({ status: "ERROR", notes: err.message });
        });
      return true; // async
    }

    if (msg.action === "emrApplyFilters") {
      log("Received emrApplyFilters command");
      applyFilters()
        .then((result) => sendResponse(result))
        .catch((err) => {
          logError("emrApplyFilters", err);
          sendResponse({ status: "ERROR", diagnostics: err.message });
        });
      return true; // async
    }

    if (msg.action === "emrScrapePage") {
      log("Received emrScrapePage command");
      try {
        const result = scrapePage();
        sendResponse(result);
      } catch (err) {
        logError("emrScrapePage", err);
        sendResponse({ status: "ERROR", patients: [], diagnostics: err.message });
      }
      return true;
    }

    if (msg.action === "emrNextPage") {
      log("Received emrNextPage command");
      goToNextPage()
        .then((result) => sendResponse(result))
        .catch((err) => {
          logError("emrNextPage", err);
          sendResponse({ hasMore: false, error: err.message });
        });
      return true; // async
    }

    if (msg.action === "ping") {
      sendResponse({
        alive: true,
        url: window.location.href,
        pageType: detectPageType(),
      });
      return true;
    }
  });

})();
