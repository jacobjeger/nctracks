"""Playwright automation engine for NCTracks eligibility verification."""

import time
import logging
from datetime import datetime, timedelta
from typing import Callable

from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext, TimeoutError

import config

logger = logging.getLogger(__name__)


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

    def request_stop(self):
        """Request the automation to stop after the current patient."""
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

    def login(self) -> bool:
        """Log into NCTracks Provider Portal via NCID.

        The login flow:
        1. Navigate to Provider Portal login URL
        2. SAML redirect to login.myncid.nc.gov
        3. Two-step NCID login: username → Next → password → Sign On
        4. MFA step: pause for user to complete MFA manually
        5. SAML redirect back to NCTracks portal
        """
        self.on_status("Navigating to NCTracks Provider Portal...")

        try:
            self.page.goto(
                config.PROVIDER_PORTAL_LOGIN,
                wait_until="domcontentloaded",
                timeout=config.PAGE_LOAD_TIMEOUT,
            )
        except TimeoutError:
            logger.warning("Page load timeout, continuing anyway...")

        # Wait for all SAML redirects to complete and land on NCID login
        self.on_status("Waiting for NCID login page...")
        self._wait_for_ncid_login_page()
        try:
            # The NCID login uses a two-step flow
            # Step 1: Enter username
            self._wait_and_fill_username()

            # Step 2: Enter password
            self._wait_and_fill_password()

            # Step 3: Handle MFA (always required)
            self._handle_mfa()

            # Step 4: Wait for redirect back to NCTracks portal
            self._wait_for_portal_landing()

            self._logged_in = True
            self.on_status("Successfully logged into NCTracks!")
            return True

        except TimeoutError as e:
            logger.error(f"Login timeout: {e}")
            self.on_status(f"Login failed: timeout waiting for page element")
            return False
        except Exception as e:
            logger.error(f"Login error: {e}")
            self.on_status(f"Login failed: {e}")
            return False

    def _wait_for_ncid_login_page(self):
        """Wait for SAML redirects to finish and NCID login page to be ready."""
        # Wait until URL contains the NCID login domain
        max_wait = 30
        start = time.time()
        while time.time() - start < max_wait:
            url = self.page.url
            if "login.myncid.nc.gov" in url or "ncid.nc.gov" in url:
                break
            time.sleep(1)
        else:
            logger.warning(f"Did not reach NCID login page. Current URL: {self.page.url}")

        # Wait for the page to fully settle after redirect
        try:
            self.page.wait_for_load_state("networkidle", timeout=15000)
        except TimeoutError:
            pass
        # Extra settling time — NCID pages have JS that enables fields after load
        time.sleep(2)

    def _wait_and_fill_username(self):
        """Fill in username on NCID login page."""
        self.on_status("Entering username...")

        # Use locators (auto-retry) instead of wait_for_selector (one-shot)
        # Try each selector, using fill with timeout to handle late-enabling fields
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
                # Wait for the field to become editable
                locator.click(timeout=5000)
                locator.fill(self.username, timeout=10000)
                filled = True
                break
            except Exception as e:
                logger.debug(f"Username selector {selector} failed: {e}")
                continue

        if not filled:
            # Last resort: find any visible text input
            self.on_status("Trying fallback username entry...")
            inputs = self.page.locator('input[type="text"]:visible')
            count = inputs.count()
            if count > 0:
                inputs.first.click(timeout=5000)
                inputs.first.fill(self.username, timeout=10000)
                filled = True

        if not filled:
            raise Exception(
                "Could not find username field. The login page may have changed. "
                "Please check the browser window."
            )

        time.sleep(0.5)

        # Click Next/Submit button
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

        # Wait for page transition after clicking Next
        try:
            self.page.wait_for_load_state("networkidle", timeout=10000)
        except TimeoutError:
            pass
        time.sleep(2)  # NCID needs time to render the password step

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
                continue

        if not filled:
            raise Exception(
                "Could not find password field. The login page may have changed."
            )

        time.sleep(0.5)

        # Click Sign On / Login button
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
        """Handle MFA step — always required.

        Pauses automation and notifies the user to complete MFA
        in the visible browser window, then waits for the portal to load.
        """
        self.on_status(
            "MFA REQUIRED: Please complete multi-factor authentication "
            "in the browser window. Waiting..."
        )
        self.on_mfa_required()

        # Wait for the user to complete MFA and get redirected to NCTracks
        # We detect completion by checking if we've left the NCID login domain
        max_wait = 300  # 5 minutes to complete MFA
        start = time.time()
        while time.time() - start < max_wait:
            current_url = self.page.url
            if (
                config.NCID_LOGIN_BASE not in current_url
                and "nctracks" in current_url.lower()
            ):
                self.on_status("MFA completed, loading portal...")
                return
            # Also check if we're on the portal
            if "ncmmisPortal" in current_url or "nctracks.nc.gov" in current_url:
                if config.NCID_LOGIN_BASE not in current_url:
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

        # Verify we're on the portal
        if "nctracks" not in self.page.url.lower():
            raise Exception(f"Unexpected URL after login: {self.page.url}")

    def navigate_to_eligibility(self):
        """Navigate to the Verify Recipient (eligibility) page.

        The portal landing is at /ncmmisPortal/site/provider/scriptLanding.htm
        The Verify Recipient page is at /DirectConnect/Eligibility/Inquiry
        Navigation: click the "Eligibility" tab in the top nav bar.
        """
        self.on_status("Navigating to eligibility verification...")

        # Check if we're already on the eligibility page
        if "Eligibility/Inquiry" in self.page.url:
            self.on_status("Already on Verify Recipient page.")
            return True

        # Approach 1: Direct URL (most reliable)
        try:
            eligibility_url = config.ELIGIBILITY_INQUIRY_URL
            self.page.goto(eligibility_url, wait_until="domcontentloaded",
                           timeout=config.PAGE_LOAD_TIMEOUT)
            try:
                self.page.wait_for_load_state("networkidle", timeout=15000)
            except TimeoutError:
                pass

            if "Eligibility/Inquiry" in self.page.url or "Verify Recipient" in self.page.inner_text("body"):
                self.on_status("On Verify Recipient page.")
                return True
        except Exception as e:
            logger.debug(f"Direct URL navigation failed: {e}")

        # Approach 2: Click the Eligibility tab in the nav bar
        try:
            elig_tab = self.page.locator('a:has-text("Eligibility")').first
            elig_tab.click(timeout=5000)
            self.page.wait_for_load_state("networkidle", timeout=config.NAVIGATION_TIMEOUT)

            # The Eligibility tab may open a submenu — look for "Verify Recipient"
            verify_link = self.page.locator('a:has-text("Verify Recipient")')
            if verify_link.count() > 0 and verify_link.first.is_visible(timeout=3000):
                verify_link.first.click()
                self.page.wait_for_load_state("networkidle", timeout=config.NAVIGATION_TIMEOUT)

            if "Eligibility/Inquiry" in self.page.url or "Verify Recipient" in self.page.inner_text("body"):
                self.on_status("On Verify Recipient page.")
                return True
        except Exception as e:
            logger.debug(f"Menu navigation failed: {e}")

        self.on_status(
            "Could not auto-navigate to eligibility page. "
            "Please navigate manually in the browser, then click Continue."
        )
        return False

    def check_patient(self, patient: dict) -> dict:
        """Check eligibility for a single patient.

        Args:
            patient: dict with keys medicaid_id, first_name, last_name, dob

        Returns:
            Result dict with keys matching OUTPUT_COLUMNS.
        """
        medicaid_id = patient.get("medicaid_id", "")
        name = f"{patient.get('first_name', '')} {patient.get('last_name', '')}".strip()
        checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        result = {
            "medicaid_id": medicaid_id,
            "name": name,
            "status": "UNKNOWN",
            "coverage_start": "",
            "coverage_end": "",
            "plan_name": "",
            "checked_at": checked_at,
            "notes": "",
        }

        self.on_status(f"Checking: {name} (ID: {medicaid_id})...")

        for attempt in range(config.MAX_RETRIES):
            try:
                # Check for session timeout
                if self._is_session_expired():
                    self.on_status("Session expired, re-logging in...")
                    if not self.login():
                        result["notes"] = "Failed to re-login after session timeout"
                        return result
                    self.navigate_to_eligibility()

                # Check for CAPTCHA
                if self._detect_captcha():
                    self.on_status("CAPTCHA detected! Please solve it in the browser.")
                    self.on_captcha_detected()
                    self._wait_for_captcha_resolution()

                # Fill in patient search
                self._fill_patient_search(patient)

                # Click search
                self._click_search()

                # Scrape results
                self._scrape_result(result)

                return result

            except TimeoutError:
                if attempt < config.MAX_RETRIES - 1:
                    self.on_status(
                        f"Timeout for {name}, retrying ({attempt + 2}/{config.MAX_RETRIES})..."
                    )
                    time.sleep(config.RETRY_DELAY_SECONDS)
                else:
                    result["notes"] = f"Timeout after {config.MAX_RETRIES} attempts"
                    result["status"] = "ERROR"

            except Exception as e:
                if attempt < config.MAX_RETRIES - 1:
                    self.on_status(
                        f"Error for {name}: {e}. Retrying ({attempt + 2}/{config.MAX_RETRIES})..."
                    )
                    time.sleep(config.RETRY_DELAY_SECONDS)
                else:
                    result["notes"] = f"Error: {e}"
                    result["status"] = "ERROR"

        return result

    def _select_dropdowns(self):
        """Select the correct Group and NPI/Atypical ID dropdowns.

        These are required Base Information fields on the Verify Recipient page.
        Values come from config (matching the provider account).
        """
        # Select Group dropdown
        group_selectors = [
            'select[name*="group" i]',
            'select[id*="group" i]',
            'select[name*="Group"]',
        ]
        group_dropdown = self._find_first_visible(group_selectors)
        if not group_dropdown:
            group_dropdown = self._find_select_by_label("Group")
        if group_dropdown:
            try:
                group_dropdown.select_option(value=config.DEFAULT_GROUP, timeout=5000)
            except Exception:
                # Try selecting by label text (partial match)
                try:
                    group_dropdown.select_option(label=config.DEFAULT_GROUP, timeout=5000)
                except Exception:
                    logger.warning(f"Could not select Group: {config.DEFAULT_GROUP}")
        else:
            logger.warning("Could not find Group dropdown")

        time.sleep(1)  # Allow page to update after group selection

        # Select NPI / Atypical ID dropdown
        npi_selectors = [
            'select[name*="npi" i]',
            'select[id*="npi" i]',
            'select[name*="Npi"]',
            'select[name*="atypical" i]',
            'select[id*="atypical" i]',
        ]
        npi_dropdown = self._find_first_visible(npi_selectors)
        if not npi_dropdown:
            npi_dropdown = self._find_select_by_label("NPI")
        if npi_dropdown:
            try:
                npi_dropdown.select_option(value=config.DEFAULT_NPI, timeout=5000)
            except Exception:
                try:
                    npi_dropdown.select_option(label=config.DEFAULT_NPI, timeout=5000)
                except Exception:
                    logger.warning(f"Could not select NPI: {config.DEFAULT_NPI}")
        else:
            logger.warning("Could not find NPI dropdown")

        time.sleep(0.5)

    def _find_select_by_label(self, label_text: str):
        """Find a select element by its associated label text."""
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

    def _fill_patient_search(self, patient: dict):
        """Fill in the Verify Recipient eligibility form.

        Only required fields:
        - Recipient ID (= Medicaid ID)
        - Date of Service From (today) / To (today + 35 days)
        - Group and NPI dropdowns (Base Information)
        """
        # First clear any previous search data
        self._clear_form()

        # Select Group and NPI dropdowns
        self._select_dropdowns()

        # Fill Recipient ID (Medicaid ID)
        medicaid_id = patient.get("medicaid_id", "")
        if not medicaid_id:
            raise Exception("Medicaid ID (Recipient ID) is required")

        recipient_field = self._find_field_by_label("Recipient ID")
        if not recipient_field:
            recipient_id_selectors = [
                'input[name*="recipientId" i]',
                'input[id*="recipientId" i]',
                'input[name*="RecipientId"]',
                'input[id*="RecipientId"]',
            ]
            recipient_field = self._find_first_visible(recipient_id_selectors)
        if recipient_field:
            recipient_field.click()
            recipient_field.fill(medicaid_id)
        else:
            raise Exception("Could not find Recipient ID field on the page")

        # Fill Date of Service From = today, To = today + 35 days
        today = datetime.now()
        dos_from = today.strftime("%m/%d/%Y")
        dos_to = (today + timedelta(days=config.DOS_RANGE_DAYS)).strftime("%m/%d/%Y")

        dos_from_field = self._find_field_by_label("Date of Service From")
        if not dos_from_field:
            dos_from_selectors = [
                'input[name*="dateOfServiceFrom" i]',
                'input[id*="dateOfServiceFrom" i]',
                'input[name*="dosFrom" i]',
                'input[name*="serviceFrom" i]',
            ]
            dos_from_field = self._find_first_visible(dos_from_selectors)
        if dos_from_field:
            dos_from_field.click()
            dos_from_field.fill(dos_from)
        else:
            raise Exception("Could not find Date of Service From field")

        dos_to_field = self._find_field_by_label("To")
        if not dos_to_field:
            dos_to_selectors = [
                'input[name*="dateOfServiceTo" i]',
                'input[id*="dateOfServiceTo" i]',
                'input[name*="dosTo" i]',
                'input[name*="serviceTo" i]',
            ]
            dos_to_field = self._find_first_visible(dos_to_selectors)
        if dos_to_field:
            dos_to_field.click()
            dos_to_field.fill(dos_to)
        else:
            raise Exception("Could not find Date of Service To field")

    def _clear_form(self):
        """Click the Clear button to reset the form, or clear fields manually."""
        try:
            clear_btn = self.page.locator('input[value="Clear"], button:has-text("Clear")').first
            if clear_btn.is_visible(timeout=2000):
                clear_btn.click()
                time.sleep(0.5)
                return
        except Exception:
            pass
        # Manual clear as fallback
        for inp in self.page.locator('input[type="text"]:visible').all():
            try:
                inp.fill("")
            except Exception:
                pass

    def _find_field_by_label(self, label_text: str):
        """Find an input field by its associated label text."""
        try:
            # Try label element with for attribute
            label = self.page.locator(f'label:has-text("{label_text}")').first
            if label.is_visible(timeout=2000):
                for_attr = label.get_attribute("for")
                if for_attr:
                    field = self.page.locator(f"#{for_attr}")
                    if field.count() > 0:
                        return field.first

            # Try finding input next to/near label text using XPath
            # Label text followed by an input
            field = self.page.locator(
                f'xpath=//td[contains(text(),"{label_text}")]/following-sibling::td//input'
            ).first
            if field.is_visible(timeout=2000):
                return field
        except Exception:
            pass

        try:
            # Try text content near input
            field = self.page.locator(
                f'xpath=//*[contains(text(),"{label_text}")]//following::input[1]'
            ).first
            if field.is_visible(timeout=2000):
                return field
        except Exception:
            pass

        return None

    def _click_search(self):
        """Click the Check Eligibility button on the Verify Recipient form."""
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

    def _scrape_result(self, result: dict):
        """Scrape eligibility result from the results page."""
        page_text = self.page.inner_text("body").upper()

        # Check for "not found" messages
        not_found_phrases = [
            "NO RECORDS FOUND",
            "NO RESULTS",
            "RECIPIENT NOT FOUND",
            "NOT FOUND",
            "NO MATCHING",
            "INVALID",
        ]
        for phrase in not_found_phrases:
            if phrase in page_text:
                result["status"] = "NOT ELIGIBLE"
                result["notes"] = "Patient not found in system"
                return

        # Check eligibility status
        if "ELIGIBLE" in page_text:
            if "NOT ELIGIBLE" in page_text or "INELIGIBLE" in page_text:
                result["status"] = "NOT ELIGIBLE"
            else:
                result["status"] = "ELIGIBLE"
        elif "ACTIVE" in page_text:
            result["status"] = "ELIGIBLE"
        elif "INACTIVE" in page_text or "TERMINATED" in page_text:
            result["status"] = "NOT ELIGIBLE"

        # Try to scrape coverage dates
        # These selectors are best-guesses and may need adjustment
        date_patterns = [
            ('coverage_start', ['td:has-text("Start") + td', 'span[id*="startDate"]']),
            ('coverage_end', ['td:has-text("End") + td', 'span[id*="endDate"]']),
            ('plan_name', ['td:has-text("Plan") + td', 'span[id*="planName"]']),
        ]

        for field_key, selectors in date_patterns:
            for selector in selectors:
                try:
                    el = self.page.locator(selector).first
                    if el.is_visible(timeout=2000):
                        result[field_key] = el.inner_text().strip()
                        break
                except Exception:
                    continue

    def _is_session_expired(self) -> bool:
        """Check if the session has timed out."""
        try:
            page_text = self.page.inner_text("body").upper()
            timeout_phrases = [
                "SESSION HAS EXPIRED",
                "SESSION TIMEOUT",
                "SESSION TIMED OUT",
                "PLEASE LOG IN AGAIN",
                "LOGIN REQUIRED",
            ]
            for phrase in timeout_phrases:
                if phrase in page_text:
                    return True

            # Also check if we've been redirected to login page
            if config.NCID_LOGIN_BASE in self.page.url:
                return True

        except Exception:
            return True

        return False

    def _detect_captcha(self) -> bool:
        """Check if a CAPTCHA is present on the page."""
        captcha_indicators = [
            'iframe[src*="captcha"]',
            'iframe[src*="recaptcha"]',
            'div.g-recaptcha',
            'div[id*="captcha"]',
            '#captcha',
        ]
        for selector in captcha_indicators:
            try:
                if self.page.locator(selector).count() > 0:
                    return True
            except Exception:
                continue
        return False

    def _wait_for_captcha_resolution(self):
        """Wait for user to solve CAPTCHA."""
        max_wait = 300  # 5 minutes
        start = time.time()
        while time.time() - start < max_wait:
            if not self._detect_captcha():
                self.on_status("CAPTCHA resolved, continuing...")
                return
            time.sleep(2)
        raise Exception("CAPTCHA timeout — not resolved within 5 minutes")

    def _click_first_match(self, selectors: list[str], description: str):
        """Click the first visible element matching any selector."""
        for selector in selectors:
            try:
                el = self.page.locator(selector).first
                if el.is_visible(timeout=3000):
                    el.click()
                    return
            except Exception:
                continue
        raise Exception(f"Could not find {description}")

    def _find_first_visible(self, selectors: list[str]):
        """Find the first visible element matching any selector."""
        for selector in selectors:
            try:
                el = self.page.locator(selector).first
                if el.is_visible(timeout=2000):
                    return el
            except Exception:
                continue
        return None

    def run_batch(self, patients: list[dict]) -> list[dict]:
        """Run eligibility check for a batch of patients.

        Returns list of result dicts.
        """
        results = []
        total = len(patients)

        for idx, patient in enumerate(patients):
            if self._stop_requested:
                self.on_status(f"Stopped by user after {idx}/{total} patients.")
                # Mark remaining as skipped
                for remaining in patients[idx:]:
                    name = f"{remaining.get('first_name', '')} {remaining.get('last_name', '')}".strip()
                    results.append({
                        "medicaid_id": remaining.get("medicaid_id", ""),
                        "name": name,
                        "status": "SKIPPED",
                        "coverage_start": "",
                        "coverage_end": "",
                        "plan_name": "",
                        "checked_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "notes": "Stopped by user",
                    })
                break

            self.on_status(f"Processing patient {idx + 1}/{total}...")
            result = self.check_patient(patient)
            results.append(result)

            # Small delay between patients to avoid rate limiting
            if idx < total - 1:
                time.sleep(1)

        return results
