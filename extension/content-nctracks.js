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
    // Skip placeholder options (empty value, "Choose", "Select", etc.)
    const isPlaceholder = (opt) => {
      const v = opt.value.trim();
      const t = opt.text.trim().toLowerCase();
      return !v || t === "choose" || t === "select" || t === "-- select --" || t === "";
    };

    // Try exact match on value
    for (const opt of el.options) {
      if (opt.value === value) {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    // Try partial match on value or text (skip placeholders)
    for (const opt of el.options) {
      if (isPlaceholder(opt)) continue;
      if (opt.value.includes(value) || opt.text.includes(value) ||
          value.includes(opt.value) || value.includes(opt.text)) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    // Try case-insensitive match (skip placeholders)
    const lowerValue = value.toLowerCase();
    for (const opt of el.options) {
      if (isPlaceholder(opt)) continue;
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

  // ─── Form Element Discovery ───
  // Since NCTracks uses dynamic JSF-style element IDs, we discover elements
  // by scanning ALL selects/inputs and matching by label text or position.

  function discoverFormElements() {
    const elements = {
      selects: [],
      inputs: [],
      buttons: [],
    };

    // Catalog all select elements
    document.querySelectorAll("select").forEach((sel) => {
      const label = findLabelFor(sel);
      elements.selects.push({
        el: sel,
        id: sel.id || "",
        name: sel.name || "",
        label: label,
        optionCount: sel.options.length,
        options: Array.from(sel.options).slice(0, 5).map((o) => `${o.value}|${o.text.trim()}`),
      });
    });

    // Catalog all text/date inputs
    document.querySelectorAll("input").forEach((inp) => {
      const type = (inp.type || "text").toLowerCase();
      if (["hidden", "checkbox", "radio"].includes(type)) return;
      const label = findLabelFor(inp);
      elements.inputs.push({
        el: inp,
        id: inp.id || "",
        name: inp.name || "",
        type: type,
        label: label,
        placeholder: inp.placeholder || "",
      });
    });

    // Catalog buttons/submit inputs AND clickable elements
    // NCTracks uses <a>, <input>, <button>, and sometimes <span> as action triggers
    document.querySelectorAll("input[type='submit'], input[type='button'], button, a, span[onclick]").forEach((btn) => {
      const text = (btn.textContent || "").trim();
      const value = btn.value || "";
      // Skip empty links and long nav text
      if ((btn.tagName === "A" || btn.tagName === "SPAN") && !text && !value) return;
      if ((btn.tagName === "A" || btn.tagName === "SPAN") && text.length > 40) return;
      elements.buttons.push({
        el: btn,
        id: btn.id || "",
        value: value,
        text: text,
        type: btn.type || btn.tagName,
      });
    });

    return elements;
  }

  function findLabelFor(el) {
    // Try explicit label
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent.trim();
    }
    // Try parent label
    const parentLabel = el.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    // Try preceding sibling or nearby text
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN")) {
      return prev.textContent.trim();
    }
    // Try parent's preceding td/th (table-based layout)
    const td = el.closest("td");
    if (td) {
      const prevTd = td.previousElementSibling;
      if (prevTd) return prevTd.textContent.trim();
    }
    return "";
  }

  function findByLabel(elements, labelPatterns, type) {
    const list = type === "select" ? elements.selects : elements.inputs;
    for (const pattern of labelPatterns) {
      const re = new RegExp(pattern, "i");
      for (const item of list) {
        if (re.test(item.label) || re.test(item.id) || re.test(item.name)) {
          return item.el;
        }
      }
    }
    return null;
  }

  function findButtonByLabel(elements, labelPatterns) {
    for (const pattern of labelPatterns) {
      const re = new RegExp(pattern, "i");
      for (const item of elements.buttons) {
        if (re.test(item.value) || re.test(item.text) || re.test(item.id)) {
          return item.el;
        }
      }
    }
    return null;
  }

  function logFormDiscovery(elements) {
    const lines = [];
    lines.push(`Page: "${document.title}" | URL: ${location.href}`);
    lines.push(`Found ${elements.selects.length} selects, ${elements.inputs.length} inputs, ${elements.buttons.length} buttons`);

    for (const s of elements.selects) {
      lines.push(`  SELECT: id="${s.id}" name="${s.name}" label="${s.label}" options(${s.optionCount}): [${s.options.join(", ")}]`);
    }
    for (const inp of elements.inputs) {
      lines.push(`  INPUT: id="${inp.id}" name="${inp.name}" type="${inp.type}" label="${inp.label}" placeholder="${inp.placeholder}"`);
    }
    for (const btn of elements.buttons) {
      lines.push(`  BUTTON: id="${btn.id}" value="${btn.value}" text="${btn.text}" type="${btn.type}"`);
    }

    // Send to background for logging
    try {
      chrome.runtime.sendMessage({
        event: "contentScriptLog",
        message: "FORM DISCOVERY:\n" + lines.join("\n"),
      });
    } catch { /* ignore */ }

    return lines;
  }

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

      // Discover all form elements on the page
      const elements = discoverFormElements();
      logFormDiscovery(elements);

      // Clear form fields programmatically instead of clicking the Clear link
      // (the Clear link is an <a href> that reloads the page, killing the content script)
      elements.inputs.forEach((inp) => {
        if (inp.type === "text" && inp.el.value) {
          inp.el.value = "";
          inp.el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });

      // ── Step 1: Account Information (first dropdown — cascades to Group) ──
      let accountSelect = findElement(CFG.ACCOUNT_SELECTORS);
      if (!accountSelect) accountSelect = findByLabel(elements, ["account.*info", "account"], "select");
      if (accountSelect) {
        // If it has options but nothing selected (or first option is blank), pick the first real option
        const realOptions = Array.from(accountSelect.options).filter((o) => o.value && o.value !== "");
        if (realOptions.length > 0 && (!accountSelect.value || accountSelect.value === "")) {
          accountSelect.value = realOptions[0].value;
          accountSelect.dispatchEvent(new Event("change", { bubbles: true }));
          diagnostics.push(`Account set to: "${realOptions[0].text.trim()}" (${realOptions[0].value})`);
          await delay(2000); // Wait for Group dropdown to populate after Account change
        } else if (accountSelect.value) {
          diagnostics.push(`Account already set: "${accountSelect.options[accountSelect.selectedIndex]?.text || accountSelect.value}"`);
        }
      } else {
        diagnostics.push("Account dropdown not found");
      }

      // ── Step 2: Group dropdown (cascades to NPI) ──
      let groupSelect = findElement(CFG.GROUP_SELECTORS);
      if (!groupSelect) groupSelect = findByLabel(elements, ["^\\*?\\s*group", "provider.*group"], "select");
      // Re-discover since Account change may have added new selects
      if (!groupSelect) {
        document.querySelectorAll("select").forEach((sel) => {
          const lbl = findLabelFor(sel);
          if (/group/i.test(lbl) && sel !== accountSelect) groupSelect = sel;
        });
      }
      if (groupSelect) {
        // Wait for Group options to populate (depends on Account selection)
        try {
          await waitFor(() => {
            const opts = Array.from(groupSelect.options).filter((o) => o.value && o.value !== "" && o.text.trim().toLowerCase() !== "choose");
            return opts.length > 0;
          }, 5000, 500);
        } catch {
          diagnostics.push("Group dropdown did not populate within 5 seconds");
        }

        const groupValue = config.defaultGroup || CFG.DEFAULT_GROUP;
        let groupSet = setSelect(groupSelect, groupValue);

        // If exact match failed, try selecting first real option
        if (!groupSet) {
          const realOpts = Array.from(groupSelect.options).filter((o) => o.value && o.value !== "" && o.text.trim().toLowerCase() !== "choose");
          if (realOpts.length === 1) {
            // Only one real option — select it
            groupSelect.value = realOpts[0].value;
            groupSelect.dispatchEvent(new Event("change", { bubbles: true }));
            groupSet = true;
            diagnostics.push(`Group auto-selected (only option): "${realOpts[0].text.trim()}"`);
          } else if (realOpts.length > 1) {
            diagnostics.push(`Group "${groupValue}" not found. Available: ${realOpts.slice(0, 5).map((o) => `"${o.text.trim()}"(${o.value})`).join(", ")}`);
            // Try first option as fallback
            groupSelect.value = realOpts[0].value;
            groupSelect.dispatchEvent(new Event("change", { bubbles: true }));
            groupSet = true;
            diagnostics.push(`Group fallback to first option: "${realOpts[0].text.trim()}"`);
          } else {
            diagnostics.push("Group dropdown has no selectable options");
          }
        } else {
          diagnostics.push(`Group matched: "${groupSelect.options[groupSelect.selectedIndex]?.text || groupValue}"`);
        }

        await delay(2000); // Wait for NPI dropdown to populate after Group change
      } else {
        diagnostics.push("Group dropdown not found on page");
      }

      // ── Step 3: NPI / Atypical ID dropdown ──
      let npiSelect = findElement(CFG.NPI_SELECTORS);
      if (!npiSelect) npiSelect = findByLabel(elements, ["npi", "atypical"], "select");
      // Re-discover if needed
      if (!npiSelect) {
        document.querySelectorAll("select").forEach((sel) => {
          const lbl = findLabelFor(sel);
          if ((/npi/i.test(lbl) || /atypical/i.test(lbl)) && sel !== accountSelect && sel !== groupSelect) {
            npiSelect = sel;
          }
        });
      }
      if (npiSelect) {
        // Wait for options to populate (depends on Group selection)
        try {
          await waitFor(() => npiSelect.options.length > 1, 10000, 500);
        } catch {
          diagnostics.push("NPI dropdown did not populate within 10 seconds");
          const currentOpts = Array.from(npiSelect.options).map((o) => `${o.value}="${o.text.trim()}"`);
          diagnostics.push(`NPI options: [${currentOpts.join(", ")}]`);
        }

        const npiValue = config.defaultNpi || CFG.DEFAULT_NPI;
        let npiSet = setSelect(npiSelect, npiValue);
        if (!npiSet) {
          // Try selecting first real option as fallback
          const realOpts = Array.from(npiSelect.options).filter((o) => o.value && o.value !== "");
          if (realOpts.length === 1) {
            npiSelect.value = realOpts[0].value;
            npiSelect.dispatchEvent(new Event("change", { bubbles: true }));
            diagnostics.push(`NPI auto-selected (only option): "${realOpts[0].text.trim()}"`);
          } else if (realOpts.length > 1) {
            diagnostics.push(`NPI "${npiValue}" not found. Available: ${realOpts.slice(0, 5).map((o) => `"${o.text.trim()}"(${o.value})`).join(", ")}`);
            // Select first as fallback
            npiSelect.value = realOpts[0].value;
            npiSelect.dispatchEvent(new Event("change", { bubbles: true }));
            diagnostics.push(`NPI fallback to first: "${realOpts[0].text.trim()}"`);
          } else {
            diagnostics.push("NPI has no selectable options");
          }
        } else {
          diagnostics.push(`NPI matched: "${npiSelect.options[npiSelect.selectedIndex]?.text || npiValue}"`);
        }
        await delay(500);
      } else {
        diagnostics.push("NPI dropdown not found on page");
      }

      // Fill Recipient ID — try config selectors, then discover by label
      let recipientField = findElement(CFG.RECIPIENT_ID_SELECTORS);
      if (!recipientField) recipientField = findByLabel(elements, ["recipient", "medicaid", "member.*id", "beneficiary"], "input");
      if (!recipientField) {
        // Last resort: find first text input that isn't a date
        const textInputs = elements.inputs.filter((i) =>
          i.type === "text" && !i.label.toLowerCase().includes("date") &&
          !i.label.toLowerCase().includes("service") && !i.name.toLowerCase().includes("date")
        );
        if (textInputs.length > 0) {
          recipientField = textInputs[0].el;
          diagnostics.push(`Using first text input as recipient field: id="${textInputs[0].id}" label="${textInputs[0].label}"`);
        }
      }

      if (!recipientField) {
        return {
          status: "ERROR",
          notes: `Recipient ID field not found. ${diagnostics.join("; ")}`,
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

      // Fill Date of Service From (today) — try config selectors, then discover
      const today = new Date();
      let dosFromField = findElement(CFG.DOS_FROM_SELECTORS);
      if (!dosFromField) dosFromField = findByLabel(elements, ["date.*service.*from", "service.*from", "date.*from", "from.*date", "dos.*from", "start.*date"], "input");
      if (!dosFromField) {
        // Try finding by placeholder pattern (mm/dd/yyyy inputs)
        const dateInputs = elements.inputs.filter((i) =>
          i.el.placeholder === "mm/dd/yyyy" || i.id.toLowerCase().includes("dateofservice") ||
          i.name.toLowerCase().includes("dateofservice") || i.id.toLowerCase().includes("servicestart")
        );
        if (dateInputs.length >= 1) {
          dosFromField = dateInputs[0].el;
          diagnostics.push(`Using discovered date input as DOS From: id="${dateInputs[0].id}" label="${dateInputs[0].label}"`);
        }
      }
      if (dosFromField) {
        fillInput(dosFromField, formatDate(today));
        diagnostics.push(`DOS From filled: id="${dosFromField.id}"`);
      } else {
        diagnostics.push("DOS From field not found");
      }
      await delay(300);

      // Fill Date of Service To — the "To:" field is right after DOS From
      const dosToDate = new Date(today);
      dosToDate.setDate(dosToDate.getDate() + (config.dosRangeDays || CFG.DOS_RANGE_DAYS));
      let dosToField = findElement(CFG.DOS_TO_SELECTORS);
      if (!dosToField) dosToField = findByLabel(elements, ["^to:?$", "service.*to", "date.*to", "dos.*to", "end.*date", "thru", "through"], "input");
      if (!dosToField && dosFromField) {
        // The "To:" input is the next sibling input after DOS From in the same row
        // Walk from dosFromField to find the next text input
        let nextEl = dosFromField.parentElement;
        while (nextEl) {
          nextEl = nextEl.nextElementSibling;
          if (!nextEl) break;
          const inp = nextEl.querySelector ? nextEl.querySelector("input[type='text'], input:not([type])") : null;
          if (inp && inp !== dosFromField) {
            dosToField = inp;
            diagnostics.push(`Found DOS To as next input after DOS From: id="${inp.id}"`);
            break;
          }
          // Also check if the element itself is an input
          if (nextEl.tagName === "INPUT" && nextEl !== dosFromField) {
            dosToField = nextEl;
            diagnostics.push(`Found DOS To as next sibling input: id="${nextEl.id}"`);
            break;
          }
        }
        // Also try: all mm/dd/yyyy inputs, pick the one that ISN'T dosFromField
        if (!dosToField) {
          const mmddInputs = elements.inputs.filter((i) =>
            i.el !== dosFromField && (
              i.el.placeholder === "mm/dd/yyyy" || i.id.toLowerCase().includes("dateofservice") ||
              i.name.toLowerCase().includes("dateofservice") || i.id.toLowerCase().includes("serviceend")
            )
          );
          if (mmddInputs.length >= 1) {
            dosToField = mmddInputs[0].el;
            diagnostics.push(`Using second date input as DOS To: id="${mmddInputs[0].id}" label="${mmddInputs[0].label}"`);
          }
        }
      }
      if (dosToField) {
        fillInput(dosToField, formatDate(dosToDate));
        diagnostics.push(`DOS To filled: id="${dosToField.id}"`);
      } else {
        diagnostics.push("DOS To field not found");
      }
      await delay(300);

      // Click Check Eligibility — specifically search for this button, NOT generic "Search" nav links
      let checkBtn = null;

      // Strategy 1: Config selectors (specific value-matching selectors only)
      checkBtn = findElement(CFG.CHECK_ELIGIBILITY_SELECTORS);

      // Strategy 2: Search discovered buttons by label pattern
      if (!checkBtn) checkBtn = findButtonByLabel(elements, ["check.*elig"]);

      // Strategy 3: Direct DOM search for elements with "Check Eligibility" text
      if (!checkBtn) {
        checkBtn = findButtonWithText(
          ["input[type='submit']", "input[type='button']", "button", "a"],
          ["Check Eligibility"]
        );
      }

      // Strategy 4: Broader text matching on discovered buttons
      if (!checkBtn) checkBtn = findButtonByLabel(elements, ["eligib"]);

      // Strategy 5: Last resort — scan ALL inputs for value containing "Eligibility"
      if (!checkBtn) {
        const allInputs = document.querySelectorAll("input");
        for (const inp of allInputs) {
          if (inp.value && /check\s*elig/i.test(inp.value)) {
            checkBtn = inp;
            diagnostics.push(`Found button via full input scan: value="${inp.value}"`);
            break;
          }
        }
      }

      if (!checkBtn) {
        // Log all discovered buttons for debugging
        const btnInfo = elements.buttons.map((b) => `[${b.type}] val="${b.value}" text="${b.text.substring(0, 25)}"`).join("; ");
        return {
          status: "ERROR",
          notes: `Submit button not found. Buttons on page: ${btnInfo}. ${diagnostics.join("; ")}`,
        };
      }

      diagnostics.push(`Clicking button: value="${checkBtn.value || ""}" text="${(checkBtn.textContent || "").trim().substring(0, 30)}"`);
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
            text.includes("PENDING") ||
            text.includes("COVERAGE");
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
        result.notes += " | " + diagnostics.join("; ");
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
