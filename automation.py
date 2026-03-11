"""Playwright automation engine for NCTracks eligibility verification."""

import re
import time
import random
import logging
from datetime import datetime, timedelta
from typing import Callable

from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext, TimeoutError

import config

logger = logging.getLogger(__name__)

# ─── Name Validation ───


def validate_scraped_name(raw_name: str, fallback: str = "") -> tuple[str, str]:
    """Strip label contamination from scraped names, flag truncation.

    Returns (cleaned_name, warning_or_empty).
    """
    name = (raw_name or fallback or "").strip()
    lower = name.lower()
    for label in config.NAME_LABEL_NOISE:
        idx = lower.find(label)
        if idx != -1:
            name = (name[:idx] + name[idx + len(label):]).strip()
            lower = name.lower()
    name = re.sub(r"\s{2,}", " ", name).strip()

    warning = ""
    if name:
        has_space = bool(re.search(r"\s", name))
        if not has_space and len(name) > 10:
            warning = "Name may be truncated — verify manually"
        if not has_space and len(name) > 5 and re.search(r"[a-z][A-Z]", name):
            warning = "Name may be truncated — verify manually"
    return name, warning


def check_payer_changed(emr_source: str, nctracks_entity: str) -> str:
    """Compare EMR payer to NCTracks managing entity using PAYER_MAPPING."""
    if not emr_source or not nctracks_entity:
        return ""
    entity_upper = nctracks_entity.upper()
    for emr_key, nct_pattern in config.PAYER_MAPPING.items():
        if emr_key.lower() in emr_source.lower():
            if nct_pattern.upper() in entity_upper:
                return "NO"
            else:
                return "YES"
    return ""


# ─── JavaScript for result scraping (injected into NCTracks page) ───

_SCRAPE_RESULTS_JS = """
() => {
    const pageText = (document.body.innerText || "").toUpperCase();
    const result = {
        status: "UNKNOWN",
        recipient_name: "", recipient_id: "", dob: "", gender: "", county: "",
        benefit_plan: "", aid_category: "", coverage_dates: "", managing_entity: "",
        managed_care_note: "", pcp_name: "", pcp_phone: "", pcp_address: "",
        tailored_care_manager: "", tcm_phone: "",
        other_insurance: "", medicare_a: "", medicare_b: "", hospice: "",
        tribal_member: "", notes: "", raw_fields: {},
    };

    // Check for error pages
    const errorIndicators = ["INTERNAL SERVER ERROR", "APPLICATION ERROR",
        "UNEXPECTED ERROR", "SYSTEM ERROR", "SERVICE UNAVAILABLE"];
    for (const phrase of errorIndicators) {
        if (pageText.includes(phrase)) {
            result.status = "ERROR";
            result.notes = "NCTracks returned a system error page";
            return result;
        }
    }

    // Check for form errors
    try {
        const errorItems = document.querySelectorAll("li a, .error li");
        const errors = Array.from(errorItems)
            .map(el => el.textContent.trim())
            .filter(t => /invalid|error|required/i.test(t));
        if (errors.length > 0) {
            result.status = "ERROR";
            result.notes = errors.join("; ");
            return result;
        }
    } catch(e) {}

    // Check for "not found"
    const notFoundPhrases = """ + str(config.NOT_FOUND_PHRASES).replace("'", '"') + """;
    for (const phrase of notFoundPhrases) {
        if (pageText.includes(phrase)) {
            result.status = "NOT FOUND";
            result.notes = "Client not found in system";
            return result;
        }
    }

    // ── Scrape label:value pairs ──
    const pairs = {};

    // Strategy 1: td pairs where label ends with ":"
    const allTds = document.querySelectorAll("td");
    for (let i = 0; i < allTds.length; i++) {
        const raw = (allTds[i].textContent || "").trim();
        if (!raw.endsWith(":") || raw.length > 80) continue;
        const label = raw.replace(/:$/, "").trim();
        if (!label) continue;
        const nextTd = allTds[i + 1];
        if (!nextTd) continue;
        const value = (nextTd.textContent || "").trim();
        if (value && value !== label) pairs[label] = value;
    }

    // Strategy 2: th + td pairs
    document.querySelectorAll("tr").forEach(row => {
        const th = row.querySelector("th");
        const td = row.querySelector("td");
        if (th && td) {
            const label = (th.textContent || "").replace(/:$/, "").trim();
            const value = (td.textContent || "").trim();
            if (label && value && label.length < 80 && !pairs[label])
                pairs[label] = value;
        }
    });

    // Strategy 3: span/label/dt elements
    document.querySelectorAll("span, label, dt").forEach(el => {
        const raw = (el.textContent || "").trim();
        if (!raw.endsWith(":") || raw.length > 80) return;
        const label = raw.replace(/:$/, "").trim();
        if (!label || pairs[label]) return;
        const next = el.nextElementSibling;
        if (next) {
            const value = (next.textContent || "").trim();
            if (value && value.length < 200) pairs[label] = value;
        }
    });

    // Strategy 4: Regex fallback for Name and DOB
    if (!pairs["Name"]) {
        const bodyText = document.body.innerText || "";
        const m = bodyText.match(/(?:Recipient\\s*)?Name\\s*:\\s*([^\\n\\r]+)/i);
        if (m) { const v = m[1].trim().split(/\\s{3,}/)[0].trim();
            if (v && v.length < 100) pairs["Name"] = v; }
    }
    if (!pairs["Date of Birth"]) {
        const bodyText = document.body.innerText || "";
        const m = bodyText.match(/Date\\s*of\\s*Birth\\s*:\\s*(\\d{2}\\/\\d{2}\\/\\d{4})/i);
        if (m) pairs["Date of Birth"] = m[1];
    }

    result.raw_fields = pairs;
    result.recipient_name = pairs["Name"] || "";
    result.dob = pairs["Date of Birth"] || "";
    result.gender = pairs["Gender"] || "";
    result.recipient_id = pairs["Recipient ID"] || "";
    result.tribal_member = pairs["Tribal Member"] || "";
    result.county = pairs["Admin County Code"] || "";
    result.pcp_name = pairs["Primary Care Provider"] || "";
    result.pcp_phone = pairs["Daytime Phone"] || "";
    result.pcp_address = pairs["Address"] || "";
    result.tailored_care_manager = pairs["Tailored Care Manager"] || "";
    result.medicare_a = pairs["Part A Eligible"] || "";
    result.medicare_b = pairs["Part B Eligible"] || "";
    result.hospice = pairs["Hospice Indicator"] || "";

    // ── Health Plan table ──
    const plans = [];
    document.querySelectorAll("table").forEach(table => {
        const headerRow = table.querySelector("tr");
        if (!headerRow) return;
        const headers = Array.from(headerRow.querySelectorAll("td, th"))
            .map(c => (c.textContent || "").trim().toUpperCase());
        if (!headers.some(h => h.includes("BENEFIT PLAN"))) return;

        const colIdx = {};
        headers.forEach((h, idx) => {
            if (h.includes("BENEFIT PLAN")) colIdx.benefit_plan = idx;
            if (h.includes("CATEGORY") && h.includes("ELIGIBILITY")) colIdx.category = idx;
            if (h.includes("DATES") && h.includes("ENROLLMENT")) colIdx.dates = idx;
            if (h.includes("MANAGING ENTITY")) colIdx.managing_entity = idx;
            if (h.includes("ADDRESS")) colIdx.address = idx;
            if (h.includes("RESIDENTIAL") || h.includes("COUNTY CODE")) colIdx.county = idx;
        });

        const rows = table.querySelectorAll("tr");
        for (let r = 1; r < rows.length; r++) {
            const cells = rows[r].querySelectorAll("td");
            if (cells.length < 3) continue;
            const gt = (idx) => idx !== undefined && cells[idx] ? cells[idx].textContent.trim() : "";
            const plan = {
                benefit_plan: gt(colIdx.benefit_plan),
                category: gt(colIdx.category),
                dates: gt(colIdx.dates),
                managing_entity: gt(colIdx.managing_entity),
                county: gt(colIdx.county),
            };
            if (plan.benefit_plan && !plan.benefit_plan.toUpperCase().includes("BENEFIT PLAN"))
                plans.push(plan);
        }
    });

    if (plans.length > 0) {
        result.benefit_plan = plans[0].benefit_plan;
        result.aid_category = plans[0].category;
        result.coverage_dates = plans[0].dates;
        result.managing_entity = plans[0].managing_entity;
        if (!result.county && plans[0].county) result.county = plans[0].county;
        if (plans.length > 1) {
            result.notes = plans.map(p =>
                p.benefit_plan + " (" + p.category + ") " + p.dates + " - " + p.managing_entity
            ).join(" | ");
        }
    }

    // ── Other Insurance ──
    document.querySelectorAll("table").forEach(table => {
        const headerRow = table.querySelector("tr");
        if (!headerRow) return;
        const headers = Array.from(headerRow.querySelectorAll("td, th"))
            .map(c => (c.textContent || "").trim().toUpperCase());
        if (!headers.some(h => h.includes("COMPANY NAME"))) return;
        const colIdx = {};
        headers.forEach((h, idx) => {
            if (h.includes("COMPANY NAME")) colIdx.company = idx;
            if (h.includes("COMPANY PHONE")) colIdx.phone = idx;
            if (h.includes("POLICY")) colIdx.policy = idx;
            if (h.includes("COVERAGE DATE")) colIdx.dates = idx;
        });
        const entries = [];
        const rows = table.querySelectorAll("tr");
        for (let r = 1; r < rows.length; r++) {
            const cells = rows[r].querySelectorAll("td");
            if (cells.length < 2) continue;
            const gt = (idx) => idx !== undefined && cells[idx] ? cells[idx].textContent.trim() : "";
            const company = gt(colIdx.company);
            if (company) {
                const policy = gt(colIdx.policy);
                const dates = gt(colIdx.dates);
                entries.push(company + (policy ? " (Policy: " + policy + ")" : "") +
                    (dates ? " " + dates : ""));
            }
        }
        if (entries.length > 0) result.other_insurance = entries.join("; ");
    });

    // ── Managed Care ──
    if (pageText.includes("ENROLLED IN MANAGED CARE"))
        result.managed_care_note = "Enrolled in Managed Care";

    // ── Status determination ──
    if (result.coverage_dates) {
        if (pageText.includes("ENROLLED IN MANAGED CARE") &&
            pageText.includes("NOT ELIGIBLE FOR PAYMENT"))
            result.status = "MANAGED CARE";
        else
            result.status = "ELIGIBLE";
    } else if (pageText.includes("NOT ELIGIBLE") || pageText.includes("INELIGIBLE")) {
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

    if (result.status === "UNKNOWN") {
        result.notes = (result.notes ? result.notes + " | " : "") +
            "Could not determine status. Page: " + document.title +
            ", " + (document.body.innerText || "").length + " chars";
    }

    return result;
}
"""


# JavaScript for Period Selection (next month comparison)
_SELECT_NEXT_PERIOD_JS = """
() => {
    const selects = document.querySelectorAll("select");
    let periodSelect = null;

    for (const sel of selects) {
        const id = (sel.id || "").toLowerCase();
        const name = (sel.name || "").toLowerCase();
        if (/period/i.test(id) || /period/i.test(name)) {
            periodSelect = sel;
            break;
        }
        if (sel.id) {
            const label = document.querySelector('label[for="' + sel.id + '"]');
            if (label && /period/i.test(label.textContent)) {
                periodSelect = sel;
                break;
            }
        }
    }

    if (!periodSelect) {
        for (const sel of selects) {
            const opts = Array.from(sel.options);
            if (opts.some(o => /\\d{2}\\/\\d{2}\\/\\d{4}/.test(o.text || o.value))) {
                periodSelect = sel;
                break;
            }
        }
    }

    if (!periodSelect) return { status: "NO_DROPDOWN" };
    if (periodSelect.options.length < 2) return { status: "NO_NEXT_PERIOD" };

    const currentIdx = periodSelect.selectedIndex;
    const currentText = periodSelect.options[currentIdx] ?
        periodSelect.options[currentIdx].text : "";

    if (currentIdx + 1 >= periodSelect.options.length)
        return { status: "NO_NEXT_PERIOD", current_period: currentText };

    const nextText = periodSelect.options[currentIdx + 1].text;
    periodSelect.selectedIndex = currentIdx + 1;
    periodSelect.dispatchEvent(new Event("change", { bubbles: true }));

    return {
        status: "OK",
        current_period: currentText,
        next_period: nextText,
    };
}
"""


class NCTracksAutomation:
    """Handles browser automation for NCTracks Provider Portal."""

    def __init__(
        self,
        username: str,
        password: str,
        on_status: Callable[[str], None] | None = None,
        on_mfa_required: Callable[[], None] | None = None,
        on_captcha_detected: Callable[[], None] | None = None,
    ):
        self.username = username
        self.password = password
        self.on_status = on_status or (lambda msg: None)
        self.on_mfa_required = on_mfa_required or (lambda: None)
        self.on_captcha_detected = on_captcha_detected or (lambda: None)
        self.playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self._logged_in = False
        self._stop_requested = False
        self._abort_requested = False

    def request_stop(self):
        """Request the automation to stop after the current client."""
        self._stop_requested = True

    def request_abort(self):
        """Immediately abort all processing."""
        self._abort_requested = True
        self._stop_requested = True

    def start_browser(self):
        """Launch the browser."""
        self.on_status("Launching browser...")
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(
            headless=config.HEADLESS,
            slow_mo=config.SLOW_MO,
        )
        self.context = self.browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(config.ELEMENT_TIMEOUT)
        self.page.set_default_navigation_timeout(config.NAVIGATION_TIMEOUT)

    def close(self):
        """Clean up browser resources."""
        try:
            if self.context:
                self.context.close()
            if self.browser:
                self.browser.close()
            if self.playwright:
                self.playwright.stop()
        except Exception as e:
            logger.warning(f"Error during browser cleanup: {e}")
        finally:
            self.page = None
            self.context = None
            self.browser = None
            self.playwright = None
            self._logged_in = False

    # ─── Login Flow ───

    def login(self) -> bool:
        """Log into NCTracks via NCID. MFA handled manually in visible browser."""
        self.on_status("Navigating to NCTracks Provider Portal...")

        try:
            self.page.goto(
                config.PROVIDER_PORTAL_LOGIN,
                wait_until="domcontentloaded",
                timeout=config.PAGE_LOAD_TIMEOUT,
            )
        except TimeoutError:
            logger.warning("Page load timeout, continuing anyway...")

        self.on_status("Waiting for NCID login page...")
        self._wait_for_ncid_login_page()

        try:
            self._wait_and_fill_username()
            self._wait_and_fill_password()
            self._handle_mfa()
            self._wait_for_portal_landing()

            self._logged_in = True
            self.on_status("Successfully logged into NCTracks!")
            return True

        except TimeoutError as e:
            logger.error(f"Login timeout: {e}")
            self.on_status("Login failed: timeout waiting for page element")
            return False
        except Exception as e:
            logger.error(f"Login error: {e}")
            self.on_status(f"Login failed: {e}")
            return False

    def _wait_for_ncid_login_page(self):
        """Wait for SAML redirects to finish and NCID login page to be ready."""
        max_wait = 30
        start = time.time()
        while time.time() - start < max_wait:
            url = self.page.url
            if "login.myncid.nc.gov" in url or "ncid.nc.gov" in url:
                break
            time.sleep(1)
        else:
            logger.warning(f"Did not reach NCID login page. URL: {self.page.url}")

        try:
            self.page.wait_for_load_state("networkidle", timeout=15000)
        except TimeoutError:
            pass
        time.sleep(2)

    def _wait_and_fill_username(self):
        """Fill in username on NCID login page."""
        self.on_status("Entering username...")

        username_selectors = [
            'input[name="pf.username"]',
            'input[id="username"]',
            'input[name="username"]',
            'input[type="text"][name*="user"]',
            'input[type="text"]',
        ]

        filled = False
        for selector in username_selectors:
            try:
                locator = self.page.locator(selector).first
                locator.wait_for(state="visible", timeout=5000)
                locator.click(timeout=5000)
                locator.fill(self.username, timeout=10000)
                filled = True
                break
            except Exception as e:
                logger.debug(f"Username selector {selector} failed: {e}")

        if not filled:
            inputs = self.page.locator('input[type="text"]:visible')
            if inputs.count() > 0:
                inputs.first.click(timeout=5000)
                inputs.first.fill(self.username, timeout=10000)
                filled = True

        if not filled:
            raise Exception("Could not find username field.")

        time.sleep(0.5)

        next_selectors = [
            'a.ping-button:has-text("Next")',
            'button:has-text("Next")',
            'a:has-text("Next")',
            'input[type="submit"]',
            'button[type="submit"]',
            '.btn-primary',
        ]
        self._click_first_match(next_selectors, "Next button")

    def _wait_and_fill_password(self):
        """Fill in password after username step."""
        self.on_status("Entering password...")

        try:
            self.page.wait_for_load_state("networkidle", timeout=10000)
        except TimeoutError:
            pass
        time.sleep(2)

        password_selectors = [
            'input[name="pf.pass"]',
            'input[id="password"]',
            'input[name="password"]',
            'input[type="password"]',
        ]

        filled = False
        for selector in password_selectors:
            try:
                locator = self.page.locator(selector).first
                locator.wait_for(state="visible", timeout=10000)
                locator.click(timeout=5000)
                locator.fill(self.password, timeout=10000)
                filled = True
                break
            except Exception as e:
                logger.debug(f"Password selector {selector} failed: {e}")

        if not filled:
            raise Exception("Could not find password field.")

        time.sleep(0.5)

        login_selectors = [
            'a.ping-button:has-text("Sign On")',
            'button:has-text("Sign On")',
            'a:has-text("Sign On")',
            'button:has-text("Sign In")',
            'button:has-text("Log In")',
            'input[type="submit"]',
            'button[type="submit"]',
        ]
        self._click_first_match(login_selectors, "Sign On button")

    def _handle_mfa(self):
        """Handle MFA — user completes manually in visible browser."""
        time.sleep(3)

        url = self.page.url
        if "login.myncid.nc.gov" not in url and "ncid.nc.gov" not in url:
            self.on_status("No MFA required — already redirected.")
            return

        try:
            page_text = self.page.inner_text("body").upper()
        except Exception:
            page_text = ""

        is_mfa = any(phrase in page_text for phrase in config.MFA_PAGE_PHRASES)

        if not is_mfa:
            time.sleep(5)
            url = self.page.url
            if "login.myncid.nc.gov" not in url and "ncid.nc.gov" not in url:
                return
            try:
                page_text = self.page.inner_text("body").upper()
            except Exception:
                page_text = ""
            is_mfa = any(phrase in page_text for phrase in config.MFA_PAGE_PHRASES)

        if is_mfa:
            self.on_status(
                "MFA REQUIRED: Please complete multi-factor authentication "
                "in the browser window. Waiting..."
            )
            self.on_mfa_required()

        max_wait = config.MFA_TIMEOUT_SECONDS
        start = time.time()
        while time.time() - start < max_wait:
            if self._abort_requested:
                raise Exception("Aborted by user")
            current_url = self.page.url
            if (config.NCID_LOGIN_BASE not in current_url
                    and "ncid.nc.gov" not in current_url):
                self.on_status("MFA completed, loading portal...")
                return
            time.sleep(2)

        raise Exception("MFA timeout — did not complete within 5 minutes")

    def _wait_for_portal_landing(self):
        """Wait for NCTracks portal to fully load after login."""
        self.on_status("Waiting for portal to load...")
        try:
            self.page.wait_for_load_state("networkidle", timeout=config.PAGE_LOAD_TIMEOUT)
        except TimeoutError:
            logger.warning("Portal load timeout, checking if page is usable...")

        if "nctracks" not in self.page.url.lower():
            raise Exception(f"Unexpected URL after login: {self.page.url}")

    # ─── Navigation ───

    def navigate_to_eligibility(self):
        """Navigate to the Verify Recipient (eligibility) page."""
        self.on_status("Navigating to eligibility verification...")

        if "Eligibility/Inquiry" in self.page.url:
            self.on_status("Already on Verify Recipient page.")
            return True

        try:
            self.page.goto(config.ELIGIBILITY_INQUIRY_URL,
                           wait_until="domcontentloaded",
                           timeout=config.PAGE_LOAD_TIMEOUT)
            try:
                self.page.wait_for_load_state("networkidle", timeout=15000)
            except TimeoutError:
                pass

            if "Eligibility/Inquiry" in self.page.url:
                self.on_status("On Verify Recipient page.")
                return True

            try:
                page_text = self.page.inner_text("body")
                if "Verify Recipient" in page_text:
                    self.on_status("On Verify Recipient page.")
                    return True
            except Exception:
                pass
        except Exception as e:
            logger.debug(f"Direct URL navigation failed: {e}")

        # Fallback: menu navigation
        try:
            elig_tab = self.page.locator('a:has-text("Eligibility")').first
            elig_tab.click(timeout=5000)
            self.page.wait_for_load_state("networkidle", timeout=config.NAVIGATION_TIMEOUT)

            verify_link = self.page.locator('a:has-text("Verify Recipient")')
            if verify_link.count() > 0 and verify_link.first.is_visible(timeout=3000):
                verify_link.first.click()
                self.page.wait_for_load_state("networkidle",
                                               timeout=config.NAVIGATION_TIMEOUT)

            if "Eligibility/Inquiry" in self.page.url:
                self.on_status("On Verify Recipient page.")
                return True
        except Exception as e:
            logger.debug(f"Menu navigation failed: {e}")

        self.on_status("Could not auto-navigate to eligibility page.")
        return False

    # ─── Client Processing ───

    def check_patient(self, patient: dict) -> dict:
        """Check eligibility for a single client. Returns full result dict."""
        medicaid_id = patient.get("medicaid_id", "")
        name = patient.get("full_name", "") or \
            f"{patient.get('first_name', '')} {patient.get('last_name', '')}".strip()
        checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        result = {
            "medicaid_id": medicaid_id,
            "name": name,
            "status": "UNKNOWN",
            "emr_funding_source": patient.get("emr_funding_source", ""),
            "insurance_type": patient.get("insurance_type", ""),
            "managing_entity": "",
            "managing_entity_next": "",
            "current_period": "",
            "next_period": "",
            "payer_changed": "",
            "payer_changed_next": "",
            "checked_at": checked_at,
            "notes": "",
        }

        self.on_status(f"Checking: {name} ({medicaid_id})...")

        for attempt in range(config.MAX_RETRIES):
            if self._abort_requested:
                result["status"] = "SKIPPED"
                result["notes"] = "Aborted by user"
                return result

            try:
                if self._is_session_expired():
                    self.on_status("Session expired, re-logging in...")
                    if not self.login():
                        result["notes"] = "Failed to re-login after session timeout"
                        result["status"] = "ERROR"
                        return result
                    self.navigate_to_eligibility()

                if self._detect_captcha():
                    self.on_status("CAPTCHA detected! Please solve it in the browser.")
                    self.on_captcha_detected()
                    self._wait_for_captcha_resolution()

                # Fill form and submit
                self._fill_patient_search(patient)
                self._click_search()

                # Scrape results
                scraped = self._scrape_result_detailed()

                # Validate scraped name
                validated_name, name_warning = validate_scraped_name(
                    scraped.get("recipient_name", ""), name
                )
                result["name"] = validated_name or name

                # Classify status
                final_status = scraped.get("status", "UNKNOWN")
                current_entity = scraped.get("managing_entity", "")

                if not current_entity and final_status not in ("ERROR", "NOT FOUND"):
                    plan_text = (scraped.get("benefit_plan", "") or "").upper()
                    if "CARVE-OUT" in plan_text or "CARVE OUT" in plan_text \
                            or plan_text == "MEDICAID":
                        final_status = "FFS"
                        self.on_status("  No managing entity — classified as FFS")

                if final_status == "UNKNOWN" and not current_entity \
                        and not scraped.get("coverage_dates"):
                    final_status = "NOT FOUND"
                    self.on_status("  No coverage data — classified as NOT FOUND")

                result["status"] = final_status
                result["managing_entity"] = current_entity or "(none)"

                # Check next period for payer changes
                current_period, next_period, next_entity = self._check_next_period()
                result["current_period"] = current_period
                result["next_period"] = next_period
                result["managing_entity_next"] = next_entity or "(none)"

                # Payer change detection
                emr_source = patient.get("emr_funding_source", "")
                result["payer_changed"] = check_payer_changed(emr_source, current_entity)

                if current_entity and next_entity:
                    result["payer_changed_next"] = (
                        "YES" if current_entity.upper() != next_entity.upper() else "NO"
                    )
                    if result["payer_changed_next"] == "YES":
                        self.on_status(
                            f"  PAYER CHANGE: {current_entity} -> {next_entity}"
                        )

                # Build notes
                notes_parts = []
                if scraped.get("notes"):
                    notes_parts.append(scraped["notes"])
                if name_warning:
                    notes_parts.append(name_warning)
                    self.on_status(f"  Warning: {name_warning}: \"{validated_name}\"")
                result["notes"] = "; ".join(notes_parts)

                self.on_status(
                    f"  Result: {final_status} | "
                    f"Entity: {current_entity or '(none)'} | "
                    f"Next: {next_entity or '(none)'}"
                )
                return result

            except TimeoutError:
                if attempt < config.MAX_RETRIES - 1:
                    self.on_status(
                        f"  Timeout, retrying ({attempt + 2}/{config.MAX_RETRIES})..."
                    )
                    time.sleep(config.RETRY_DELAY_SECONDS)
                    try:
                        self.navigate_to_eligibility()
                    except Exception:
                        pass
                else:
                    result["notes"] = f"Timeout after {config.MAX_RETRIES} attempts"
                    result["status"] = "ERROR"

            except Exception as e:
                if attempt < config.MAX_RETRIES - 1:
                    self.on_status(
                        f"  Error: {e}. Retrying ({attempt + 2}/{config.MAX_RETRIES})..."
                    )
                    time.sleep(config.RETRY_DELAY_SECONDS)
                    try:
                        self.navigate_to_eligibility()
                    except Exception:
                        pass
                else:
                    result["notes"] = f"Error: {e}"
                    result["status"] = "ERROR"

        return result

    def _fill_patient_search(self, patient: dict):
        """Fill the Verify Recipient eligibility form."""
        self._clear_form()
        self._select_dropdowns()

        # Recipient ID
        medicaid_id = patient.get("medicaid_id", "")
        if not medicaid_id:
            raise Exception("Medicaid ID is required")

        recipient_field = self._find_field_by_label("Recipient ID")
        if not recipient_field:
            for sel in ['input[name*="recipientId" i]', 'input[id*="recipientId" i]',
                        'input[name*="RecipientId"]', 'input[id*="RecipientId"]']:
                recipient_field = self._find_first_visible([sel])
                if recipient_field:
                    break
        if recipient_field:
            recipient_field.click()
            recipient_field.fill(medicaid_id)
        else:
            raise Exception("Could not find Recipient ID field")

        # Date of Service
        today = datetime.now()
        dos_from = today.strftime("%m/%d/%Y")
        dos_to = (today + timedelta(days=config.DOS_RANGE_DAYS)).strftime("%m/%d/%Y")

        dos_from_field = self._find_field_by_label("Date of Service From")
        if not dos_from_field:
            dos_from_field = self._find_first_visible([
                'input[id*="DateOfServiceStart" i]',
                'input[name*="dateOfServiceFrom" i]',
                'input[name*="dosFrom" i]',
            ])
        if dos_from_field:
            dos_from_field.click()
            dos_from_field.fill(dos_from)

        dos_to_field = self._find_field_by_label("To")
        if not dos_to_field:
            dos_to_field = self._find_first_visible([
                'input[id*="DateOfServiceEnd" i]',
                'input[name*="dateOfServiceTo" i]',
                'input[name*="dosTo" i]',
            ])
        if dos_to_field:
            dos_to_field.click()
            dos_to_field.fill(dos_to)

    def _select_dropdowns(self):
        """Select Account, Group and NPI dropdowns."""
        # Account — select first non-empty option
        account = self._find_first_visible([
            'select[name*="account" i]', 'select[id*="account" i]',
        ]) or self._find_select_by_label("Account")
        if account:
            try:
                self.page.evaluate("""
                    (sel) => {
                        const opts = Array.from(sel.options)
                            .filter(o => o.value && o.value !== "");
                        if (opts.length > 0) {
                            sel.value = opts[0].value;
                            sel.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                    }
                """, account.element_handle())
                time.sleep(2)
            except Exception as e:
                logger.warning(f"Could not select Account: {e}")

        # Group
        group = self._find_first_visible([
            'select[name*="group" i]', 'select[id*="group" i]',
        ]) or self._find_select_by_label("Group")
        if group:
            try:
                group.select_option(value=config.DEFAULT_GROUP, timeout=5000)
            except Exception:
                try:
                    group.select_option(label=config.DEFAULT_GROUP, timeout=5000)
                except Exception:
                    logger.warning(f"Could not select Group: {config.DEFAULT_GROUP}")
        time.sleep(1)

        # NPI
        npi = self._find_first_visible([
            'select[name*="npi" i]', 'select[id*="npi" i]',
            'select[name*="atypical" i]', 'select[id*="atypical" i]',
        ]) or self._find_select_by_label("NPI")
        if npi:
            try:
                npi.select_option(value=config.DEFAULT_NPI, timeout=5000)
            except Exception:
                try:
                    npi.select_option(label=config.DEFAULT_NPI, timeout=5000)
                except Exception:
                    logger.warning(f"Could not select NPI: {config.DEFAULT_NPI}")
        time.sleep(0.5)

    def _clear_form(self):
        """Click Clear or manually clear text fields."""
        try:
            clear_btn = self.page.locator(
                'input[value="Clear"], button:has-text("Clear")'
            ).first
            if clear_btn.is_visible(timeout=2000):
                clear_btn.click()
                time.sleep(0.5)
                return
        except Exception:
            pass
        for inp in self.page.locator('input[type="text"]:visible').all():
            try:
                inp.fill("")
            except Exception:
                pass

    def _click_search(self):
        """Click the Check Eligibility button."""
        search_selectors = [
            'input[value="Check Eligibility"]',
            'button:has-text("Check Eligibility")',
            'input[value*="Check Elig"]',
            'input[type="submit"][value*="Eligib"]',
            'button:has-text("Search")',
            'input[type="submit"]',
            'button[type="submit"]',
        ]
        self._click_first_match(search_selectors, "Check Eligibility button")
        self.page.wait_for_load_state("networkidle", timeout=config.NAVIGATION_TIMEOUT)
        time.sleep(2)

    def _scrape_result_detailed(self) -> dict:
        """Scrape detailed eligibility result via injected JS."""
        try:
            return self.page.evaluate(_SCRAPE_RESULTS_JS)
        except Exception as e:
            logger.error(f"Result scraping failed: {e}")
            return {"status": "ERROR", "notes": f"Scrape error: {e}"}

    def _check_next_period(self) -> tuple[str, str, str]:
        """Select next period, scrape managing entity.

        Returns (current_period, next_period, next_entity).
        """
        try:
            period_result = self.page.evaluate(_SELECT_NEXT_PERIOD_JS)

            if period_result["status"] != "OK":
                return (period_result.get("current_period", ""), "", "")

            try:
                self.page.wait_for_load_state("networkidle", timeout=15000)
            except TimeoutError:
                pass
            time.sleep(2)

            next_result = self._scrape_result_detailed()
            next_entity = next_result.get("managing_entity", "")

            return (
                period_result.get("current_period", ""),
                period_result.get("next_period", ""),
                next_entity,
            )
        except Exception as e:
            logger.debug(f"Next period check failed: {e}")
            return ("", "", "")

    # ─── Detection Helpers ───

    def _is_session_expired(self) -> bool:
        """Check if the session has timed out."""
        try:
            page_text = self.page.inner_text("body").upper()
            for phrase in config.SESSION_TIMEOUT_PHRASES:
                if phrase in page_text:
                    return True
            if config.NCID_LOGIN_BASE in self.page.url:
                return True
        except Exception:
            return True
        return False

    def _detect_captcha(self) -> bool:
        """Check if a CAPTCHA is present."""
        for sel in ['iframe[src*="captcha"]', 'iframe[src*="recaptcha"]',
                     'div.g-recaptcha', 'div[id*="captcha"]', '#captcha']:
            try:
                if self.page.locator(sel).count() > 0:
                    return True
            except Exception:
                continue
        return False

    def _wait_for_captcha_resolution(self):
        """Wait for user to solve CAPTCHA."""
        max_wait = 300
        start = time.time()
        while time.time() - start < max_wait:
            if self._abort_requested:
                raise Exception("Aborted by user")
            if not self._detect_captcha():
                self.on_status("CAPTCHA resolved, continuing...")
                return
            time.sleep(2)
        raise Exception("CAPTCHA timeout — not resolved within 5 minutes")

    # ─── Element Discovery ───

    def _click_first_match(self, selectors: list[str], description: str):
        for sel in selectors:
            try:
                el = self.page.locator(sel).first
                if el.is_visible(timeout=3000):
                    el.click()
                    return
            except Exception:
                continue
        raise Exception(f"Could not find {description}")

    def _find_first_visible(self, selectors: list[str]):
        for sel in selectors:
            try:
                el = self.page.locator(sel).first
                if el.is_visible(timeout=2000):
                    return el
            except Exception:
                continue
        return None

    def _find_field_by_label(self, label_text: str):
        try:
            label = self.page.locator(f'label:has-text("{label_text}")').first
            if label.is_visible(timeout=2000):
                for_attr = label.get_attribute("for")
                if for_attr:
                    field = self.page.locator(f"#{for_attr}")
                    if field.count() > 0:
                        return field.first
        except Exception:
            pass
        try:
            field = self.page.locator(
                f'xpath=//td[contains(text(),"{label_text}")]/following-sibling::td//input'
            ).first
            if field.is_visible(timeout=2000):
                return field
        except Exception:
            pass
        try:
            field = self.page.locator(
                f'xpath=//*[contains(text(),"{label_text}")]//following::input[1]'
            ).first
            if field.is_visible(timeout=2000):
                return field
        except Exception:
            pass
        return None

    def _find_select_by_label(self, label_text: str):
        try:
            label = self.page.locator(f'label:has-text("{label_text}")').first
            if label.is_visible(timeout=2000):
                for_attr = label.get_attribute("for")
                if for_attr:
                    field = self.page.locator(f"select#{for_attr}")
                    if field.count() > 0:
                        return field.first
        except Exception:
            pass
        try:
            field = self.page.locator(
                f'xpath=//*[contains(text(),"{label_text}")]//following::select[1]'
            ).first
            if field.is_visible(timeout=2000):
                return field
        except Exception:
            pass
        return None

    # ─── Batch Processing ───

    def run_batch(self, patients: list[dict],
                  on_progress: Callable[[int, int], None] | None = None) -> list[dict]:
        """Run eligibility check for a batch of clients."""
        results = []
        total = len(patients)

        for idx, patient in enumerate(patients):
            if self._stop_requested or self._abort_requested:
                self.on_status(f"Stopped after {idx}/{total} clients.")
                for remaining in patients[idx:]:
                    rname = remaining.get("full_name", "") or \
                        f"{remaining.get('first_name', '')} {remaining.get('last_name', '')}".strip()
                    results.append({
                        "medicaid_id": remaining.get("medicaid_id", ""),
                        "name": rname,
                        "status": "SKIPPED",
                        "emr_funding_source": remaining.get("emr_funding_source", ""),
                        "insurance_type": remaining.get("insurance_type", ""),
                        "managing_entity": "",
                        "managing_entity_next": "",
                        "current_period": "",
                        "next_period": "",
                        "payer_changed": "",
                        "payer_changed_next": "",
                        "checked_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "notes": "Stopped by user",
                    })
                break

            if on_progress:
                on_progress(idx + 1, total)

            result = self.check_patient(patient)
            results.append(result)

            # Navigate back to form for next client
            if idx < total - 1 and not self._stop_requested:
                try:
                    self.navigate_to_eligibility()
                except Exception as e:
                    self.on_status(f"Navigation error: {e}")

            # Random delay 2-4 seconds
            if idx < total - 1:
                time.sleep(2 + random.random() * 2)

        return results
