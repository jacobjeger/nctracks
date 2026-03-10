"""Playwright automation engine for NCTracks eligibility verification."""

import time
import logging
from datetime import datetime
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
                wait_until="networkidle",
                timeout=config.PAGE_LOAD_TIMEOUT,
            )
        except TimeoutError:
            # Page may still be usable even if networkidle times out
            logger.warning("Page load timeout, continuing anyway...")

        # Wait for redirect to NCID login page
        self.on_status("Waiting for NCID login page...")
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

    def _wait_and_fill_username(self):
        """Fill in username on NCID login page."""
        self.on_status("Entering username...")

        # Try multiple possible selectors for the username field
        username_selectors = [
            'input[name="pf.username"]',
            'input[id="username"]',
            'input[name="username"]',
            'input[type="text"][name*="user"]',
            'input[type="text"]',
        ]

        username_field = None
        for selector in username_selectors:
            try:
                username_field = self.page.wait_for_selector(
                    selector, state="visible", timeout=config.ELEMENT_TIMEOUT
                )
                if username_field:
                    break
            except TimeoutError:
                continue

        if not username_field:
            raise Exception(
                "Could not find username field. The login page may have changed. "
                "Please check the browser window."
            )

        username_field.fill(self.username)

        # Click Next/Submit button
        next_selectors = [
            'a.ping-button:has-text("Next")',
            'button:has-text("Next")',
            'input[type="submit"]',
            'button[type="submit"]',
            '.btn-primary',
        ]
        self._click_first_match(next_selectors, "Next button")

    def _wait_and_fill_password(self):
        """Fill in password after username step."""
        self.on_status("Entering password...")
        time.sleep(1)  # Brief pause for page transition

        password_selectors = [
            'input[name="pf.pass"]',
            'input[id="password"]',
            'input[name="password"]',
            'input[type="password"]',
        ]

        password_field = None
        for selector in password_selectors:
            try:
                password_field = self.page.wait_for_selector(
                    selector, state="visible", timeout=config.ELEMENT_TIMEOUT
                )
                if password_field:
                    break
            except TimeoutError:
                continue

        if not password_field:
            raise Exception(
                "Could not find password field. The login page may have changed."
            )

        password_field.fill(self.password)

        # Click Sign On / Login button
        login_selectors = [
            'a.ping-button:has-text("Sign On")',
            'button:has-text("Sign On")',
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
        """Navigate to the eligibility verification screen.

        The exact navigation path depends on the portal's menu structure.
        Common paths:
        - Recipient Eligibility Verification under a main menu
        - Direct URL if known
        """
        self.on_status("Navigating to eligibility verification...")

        # Try common navigation approaches
        nav_attempts = [
            # Approach 1: Click through menus
            self._navigate_via_menu,
            # Approach 2: Direct URL (if the portal uses predictable URLs)
            self._navigate_via_url,
            # Approach 3: Search the page for eligibility links
            self._navigate_via_search,
        ]

        for attempt in nav_attempts:
            try:
                if attempt():
                    self.on_status("On eligibility verification page.")
                    return True
            except Exception as e:
                logger.debug(f"Navigation attempt failed: {e}")
                continue

        self.on_status(
            "Could not auto-navigate to eligibility page. "
            "Please navigate manually in the browser, then click Continue."
        )
        return False

    def _navigate_via_menu(self) -> bool:
        """Try to navigate through portal menus."""
        # Common menu text patterns for eligibility
        menu_texts = [
            "Recipient",
            "Eligibility",
            "Verify Eligibility",
            "Recipient Eligibility",
            "Eligibility Verification",
        ]

        for text in menu_texts:
            try:
                link = self.page.locator(f'a:has-text("{text}")').first
                if link.is_visible(timeout=3000):
                    link.click()
                    self.page.wait_for_load_state("networkidle", timeout=config.NAVIGATION_TIMEOUT)
                    return True
            except Exception:
                continue
        return False

    def _navigate_via_url(self) -> bool:
        """Try direct URLs for eligibility page."""
        possible_urls = [
            f"{config.NCTRACKS_HOME}/ncmmisPortal/eligibilityAction",
            f"{config.NCTRACKS_HOME}/ncmmisPortal/recipientEligibility",
        ]
        for url in possible_urls:
            try:
                response = self.page.goto(url, timeout=config.NAVIGATION_TIMEOUT)
                if response and response.ok:
                    return True
            except Exception:
                continue
        return False

    def _navigate_via_search(self) -> bool:
        """Search the page for any eligibility-related links."""
        try:
            links = self.page.locator('a[href*="ligib"]').all()
            for link in links:
                if link.is_visible():
                    link.click()
                    self.page.wait_for_load_state("networkidle", timeout=config.NAVIGATION_TIMEOUT)
                    return True
        except Exception:
            pass
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

    def _fill_patient_search(self, patient: dict):
        """Fill in the eligibility search form for a patient."""
        # Try to find and fill Medicaid ID field
        id_selectors = [
            'input[name*="medicaidId"]',
            'input[name*="recipientId"]',
            'input[name*="memberId"]',
            'input[id*="medicaidId"]',
            'input[id*="recipientId"]',
            'input[id*="memberId"]',
            'input[id*="MedicaidId"]',
        ]
        id_field = self._find_first_visible(id_selectors)
        if id_field:
            id_field.fill("")
            id_field.fill(patient.get("medicaid_id", ""))
        else:
            # Fall back to name-based search
            self._fill_name_search(patient)

    def _fill_name_search(self, patient: dict):
        """Fill name and DOB fields as fallback search."""
        first_selectors = [
            'input[name*="firstName"]',
            'input[id*="firstName"]',
            'input[name*="first_name"]',
        ]
        last_selectors = [
            'input[name*="lastName"]',
            'input[id*="lastName"]',
            'input[name*="last_name"]',
        ]
        dob_selectors = [
            'input[name*="dob"]',
            'input[name*="dateOfBirth"]',
            'input[name*="birthDate"]',
            'input[id*="dob"]',
            'input[id*="dateOfBirth"]',
        ]

        first_field = self._find_first_visible(first_selectors)
        if first_field:
            first_field.fill(patient.get("first_name", ""))

        last_field = self._find_first_visible(last_selectors)
        if last_field:
            last_field.fill(patient.get("last_name", ""))

        dob_field = self._find_first_visible(dob_selectors)
        if dob_field:
            dob_field.fill(patient.get("dob", ""))

    def _click_search(self):
        """Click the search/submit button on the eligibility form."""
        search_selectors = [
            'button:has-text("Search")',
            'input[type="submit"][value*="Search"]',
            'button:has-text("Verify")',
            'button:has-text("Submit")',
            'input[type="submit"]',
            'button[type="submit"]',
            'a:has-text("Search")',
        ]
        self._click_first_match(search_selectors, "Search button")
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
