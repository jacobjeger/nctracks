"""Passage Health EMR scraper — logs in, filters Funding Sources report, scrapes clients."""
from __future__ import annotations

import logging
import time
from typing import Callable

from playwright.sync_api import Page, TimeoutError

import config

logger = logging.getLogger(__name__)

# JavaScript injected into the page to scrape table data efficiently
_SCRAPE_TABLE_JS = """
() => {
    const tables = document.querySelectorAll("table");
    if (!tables.length) return { status: "NO_TABLE", clients: [] };

    // Find the data table (the one with the most rows)
    let dataTable = null;
    let maxRows = 0;
    for (const t of tables) {
        const rows = t.querySelectorAll("tr");
        if (rows.length > maxRows) {
            maxRows = rows.length;
            dataTable = t;
        }
    }
    if (!dataTable || maxRows < 2) return { status: "EMPTY_TABLE", clients: [] };

    const rows = dataTable.querySelectorAll("tr");
    const headerRow = rows[0];
    const headers = Array.from(headerRow.querySelectorAll("td, th"))
        .map(c => (c.textContent || "").trim().toUpperCase());

    // Detect columns
    const colIdx = {};
    headers.forEach((h, idx) => {
        if (/^(CLIENT|PATIENT|NAME|FULL\\s*NAME)$/i.test(h)) colIdx.name = idx;
        if (/^CLIENT\\s*ID$/.test(h)) colIdx.client_id = idx;
        if (/^(FUNDING\\s*SOURCE|PAYER|INSURANCE)$/i.test(h)) colIdx.funding = idx;
        if (/^(MEDICAID\\s*ID|MEMBER\\s*ID)$/.test(h)) colIdx.member_id = idx;
        if (/^TYPE$/.test(h)) colIdx.insurance_type = idx;
        if (/^PLAN\\s*NAME$/.test(h)) colIdx.plan_name = idx;
        if (/^GROUP\\s*NUMBER$/.test(h)) colIdx.group_number = idx;
        if (/^START/.test(h)) colIdx.start_date = idx;
        if (/^STATUS$/.test(h)) colIdx.status = idx;
    });

    if (colIdx.name === undefined && colIdx.member_id === undefined) {
        return { status: "NO_COLUMNS", clients: [], headers: headers };
    }

    const inactiveStatuses = %INACTIVE_STATUSES%;
    const clients = [];

    for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].querySelectorAll("td");
        if (cells.length < 3) continue;
        const getText = (idx) => idx !== undefined && cells[idx]
            ? (cells[idx].textContent || "").trim() : "";

        const statusText = getText(colIdx.status).toLowerCase();
        if (statusText && inactiveStatuses.includes(statusText)) continue;

        const fullName = getText(colIdx.name);
        const medicaidId = getText(colIdx.member_id);
        const payer = getText(colIdx.funding);
        if (!medicaidId && !fullName) continue;

        // Split name into first/last
        let firstName = "", lastName = "";
        if (fullName.includes(",")) {
            const parts = fullName.split(",").map(s => s.trim());
            lastName = parts[0];
            firstName = parts.slice(1).join(" ");
        } else {
            const parts = fullName.split(/\\s+/);
            firstName = parts[0] || "";
            lastName = parts.slice(1).join(" ") || "";
        }

        clients.push({
            medicaid_id: medicaidId,
            first_name: firstName,
            last_name: lastName,
            full_name: fullName,
            emr_funding_source: payer,
            insurance_type: getText(colIdx.insurance_type),
            plan_name: getText(colIdx.plan_name),
            group_number: getText(colIdx.group_number),
            start_date: getText(colIdx.start_date),
            client_id: getText(colIdx.client_id),
        });
    }

    return { status: "OK", clients: clients, rowCount: rows.length - 1 };
}
""".replace("%INACTIVE_STATUSES%", str(config.INACTIVE_STATUSES).replace("'", '"'))


class PassageHealthScraper:
    """Scrapes client data from Passage Health EMR Funding Sources report."""

    def __init__(self, page: Page, on_status: Callable[[str], None] | None = None):
        self.page = page
        self.on_status = on_status or (lambda msg: None)

    def login(self, email: str, password: str) -> bool:
        """Log into Passage Health EMR. Returns True if successful."""
        self.on_status("Navigating to Passage Health EMR...")
        try:
            self.page.goto(config.PASSAGEHEALTH_LOGIN_URL, wait_until="domcontentloaded",
                           timeout=config.PAGE_LOAD_TIMEOUT)
        except TimeoutError:
            logger.warning("EMR page load timeout, continuing...")

        time.sleep(config.EMR_PAGE_LOAD_DELAY)

        # Check if already logged in (URL contains /dashboard)
        if "/dashboard" in self.page.url:
            self.on_status("Already logged into EMR.")
            return True

        self.on_status("Logging into EMR...")

        # Find and fill email field
        email_selectors = [
            'input[type="email"]',
            'input[name*="email" i]',
            'input[id*="email" i]',
            'input[placeholder*="email" i]',
            'input[type="text"]',
        ]
        if not self._fill_field(email_selectors, email, "email"):
            self.on_status("Could not find EMR email field.")
            return False

        # Find and fill password field
        password_selectors = [
            'input[type="password"]',
            'input[name*="password" i]',
            'input[id*="password" i]',
        ]
        if not self._fill_field(password_selectors, password, "password"):
            self.on_status("Could not find EMR password field.")
            return False

        # Click login button
        login_selectors = [
            'button[type="submit"]',
            'button:has-text("Log In")',
            'button:has-text("Sign In")',
            'button:has-text("Login")',
            'input[type="submit"]',
        ]
        if not self._click_first(login_selectors, "login button"):
            self.on_status("Could not find EMR login button.")
            return False

        # Wait for dashboard
        try:
            self.page.wait_for_url("**/dashboard**", timeout=30_000)
        except TimeoutError:
            if "/dashboard" not in self.page.url:
                self.on_status(f"EMR login may have failed. URL: {self.page.url}")
                return False

        time.sleep(config.EMR_PAGE_LOAD_DELAY)
        self.on_status("EMR login successful.")
        return True

    def scrape_funding_sources(self, payers: list[str] | None = None) -> list[dict]:
        """Scrape all clients from the Funding Sources report.

        Args:
            payers: List of payer names to filter by. Defaults to config list.

        Returns:
            List of client dicts with keys: medicaid_id, first_name, last_name,
            full_name, emr_funding_source, insurance_type, etc.
        """
        if payers is None:
            payers = config.PASSAGEHEALTH_FUNDING_SOURCES

        # Navigate to Funding Sources report
        self.on_status("Navigating to Funding Sources report...")
        try:
            self.page.goto(config.PASSAGEHEALTH_FUNDING_SOURCES_URL,
                           wait_until="domcontentloaded",
                           timeout=config.PAGE_LOAD_TIMEOUT)
        except TimeoutError:
            logger.warning("Funding Sources page load timeout, continuing...")

        time.sleep(config.EMR_PAGE_LOAD_DELAY)

        # Wait for table to appear
        try:
            self.page.wait_for_selector("table", timeout=15_000)
        except TimeoutError:
            self.on_status("No table found on Funding Sources page.")
            return []

        # Apply payer filters
        self._apply_payer_filters(payers)

        # Scrape all pages
        all_clients = []
        page_num = 0
        while True:
            page_num += 1
            self.on_status(f"Scraping page {page_num}...")

            clients = self._scrape_page()
            if clients:
                all_clients.extend(clients)
                self.on_status(f"Page {page_num}: {len(clients)} clients found")
            else:
                if page_num == 1:
                    self.on_status("No clients found on first page.")
                break

            if not self._next_page():
                self.on_status(f"No more pages after page {page_num}")
                break

        # Deduplicate by composite key (medicaid_id|payer|type)
        seen = set()
        unique_clients = []
        for c in all_clients:
            key = (
                f"{c['medicaid_id']}|"
                f"{c.get('emr_funding_source', '').lower()}|"
                f"{c.get('insurance_type', '').lower()}"
            )
            if key not in seen:
                seen.add(key)
                unique_clients.append(c)

        # Count multi-insurance clients
        id_counts = {}
        for c in unique_clients:
            mid = c["medicaid_id"]
            id_counts[mid] = id_counts.get(mid, 0) + 1
        multi = sum(1 for v in id_counts.values() if v > 1)

        self.on_status(
            f"EMR scrape complete: {len(unique_clients)} rows across {page_num} pages"
            + (f" ({multi} clients with multiple insurances)" if multi else "")
        )
        return unique_clients

    def _apply_payer_filters(self, payers: list[str]):
        """Open filter panel and select payers in the Mantine MultiSelect."""
        self.on_status(f"Applying payer filters ({len(payers)} payers)...")

        # Find and click filter button — look for button with filter SVG icon
        filter_clicked = False

        # Strategy 1: aria-label or title containing "filter"
        for sel in [
            'button[aria-label*="filter" i]',
            'button[title*="filter" i]',
            'button[aria-haspopup="dialog"]',
        ]:
            try:
                btn = self.page.locator(sel).first
                if btn.is_visible(timeout=2000):
                    btn.click()
                    filter_clicked = True
                    break
            except Exception:
                continue

        # Strategy 2: Find button containing SVG with horizontal lines (filter icon)
        if not filter_clicked:
            try:
                # Use JS to find filter button by SVG path analysis
                filter_clicked = self.page.evaluate("""
                    () => {
                        const buttons = document.querySelectorAll("button");
                        for (const btn of buttons) {
                            const svg = btn.querySelector("svg");
                            if (!svg) continue;
                            const paths = svg.querySelectorAll("path, line");
                            if (paths.length < 3) continue;
                            const d = Array.from(paths).map(p =>
                                p.getAttribute("d") || "").join(" ");
                            // Filter icon: 3 horizontal lines at y=6, y=12, y=18
                            if (/M\\d+\\s+6h/i.test(d) && /M\\d+\\s+12h/i.test(d) &&
                                /M\\d+\\s+18h/i.test(d)) {
                                btn.click();
                                return true;
                            }
                        }
                        return false;
                    }
                """)
            except Exception:
                pass

        if not filter_clicked:
            self.on_status("Could not find filter button — proceeding without filters.")
            return

        time.sleep(config.EMR_FILTER_DELAY)

        # Find the "Payer" labeled Mantine MultiSelect
        try:
            payer_label = self.page.locator('label:has-text("Payer")').first
            payer_label.wait_for(state="visible", timeout=5000)
            for_id = payer_label.get_attribute("for")
            if for_id:
                search_input = self.page.locator(f"#{for_id}")
            else:
                # Fallback: find search input near the label
                parent = payer_label.locator("xpath=..")
                search_input = parent.locator('input[type="search"]').first
        except Exception as e:
            self.on_status(f"Could not find Payer filter input: {e}")
            return

        # Type each payer name and select from dropdown
        selected_count = 0
        for payer in payers:
            try:
                search_input.fill(payer)
                time.sleep(0.8)  # Wait for dropdown to populate

                # Click the matching option
                option = self.page.locator(f"[role='option']:has-text('{payer}')").first
                option.wait_for(state="visible", timeout=3000)
                option.click()
                selected_count += 1
                self.on_status(f"  Selected payer: {payer}")
                time.sleep(0.5)
            except Exception as e:
                logger.warning(f"Could not select payer '{payer}': {e}")
                # Clear the search input for next try
                try:
                    search_input.fill("")
                except Exception:
                    pass

        self.on_status(f"Selected {selected_count}/{len(payers)} payers")

        # Click Done button
        try:
            done_btn = self.page.locator('button:has-text("Done")').first
            if not done_btn.is_visible(timeout=2000):
                done_btn = self.page.locator('button[class*="bg-primary"]').first
            done_btn.click()
        except Exception as e:
            logger.warning(f"Could not click Done button: {e}")

        # Wait for table to reload
        time.sleep(config.EMR_FILTER_DELAY)
        try:
            self.page.wait_for_selector("table tbody tr", timeout=15_000)
        except TimeoutError:
            self.on_status("Table did not reload after filter — continuing anyway.")

        self.on_status("Payer filters applied.")

    def _scrape_page(self) -> list[dict]:
        """Scrape client data from the current table page."""
        try:
            result = self.page.evaluate(_SCRAPE_TABLE_JS)
            if result["status"] == "OK":
                return result["clients"]
            else:
                logger.warning(f"Table scrape returned: {result['status']}")
                return []
        except Exception as e:
            logger.error(f"Page scrape error: {e}")
            return []

    def _next_page(self) -> bool:
        """Click next page button. Returns True if there's a next page."""
        try:
            # Store old table content for change detection
            old_content = self.page.evaluate("""
                () => {
                    const tbody = document.querySelector("table tbody");
                    return tbody ? tbody.textContent : "";
                }
            """)

            # Find next page button
            next_btn = None
            for sel in [
                'button[aria-label*="next" i]',
                'a[aria-label*="next" i]',
            ]:
                try:
                    btn = self.page.locator(sel).first
                    if btn.is_visible(timeout=1000):
                        next_btn = btn
                        break
                except Exception:
                    continue

            # Fallback: find by text
            if not next_btn:
                for text in ["Next", ">", "»"]:
                    try:
                        btn = self.page.locator(f'button:has-text("{text}")').first
                        if btn.is_visible(timeout=1000):
                            next_btn = btn
                            break
                    except Exception:
                        continue

            # Fallback: pagination container — find active page, get next sibling
            if not next_btn:
                try:
                    next_btn = self.page.evaluate("""
                        () => {
                            const pager = document.querySelector(
                                "nav[aria-label*='pagination'], [class*='pagination'], [class*='pager']");
                            if (!pager) return null;
                            const active = pager.querySelector(
                                ".active, [aria-current='page'], [class*='current']");
                            if (!active) return null;
                            const next = active.nextElementSibling;
                            if (next && !next.classList.contains('disabled')) {
                                next.click();
                                return true;
                            }
                            return null;
                        }
                    """)
                    if next_btn is True:
                        # Already clicked via JS
                        time.sleep(2)
                        return True
                except Exception:
                    pass

            if not next_btn:
                return False

            # Check if disabled
            is_disabled = next_btn.is_disabled() if hasattr(next_btn, 'is_disabled') else False
            if not is_disabled:
                try:
                    is_disabled = next_btn.get_attribute("aria-disabled") == "true"
                except Exception:
                    pass
            if is_disabled:
                return False

            next_btn.click()

            # Wait for content to change
            max_wait = 15
            start = time.time()
            while time.time() - start < max_wait:
                new_content = self.page.evaluate("""
                    () => {
                        const tbody = document.querySelector("table tbody");
                        return tbody ? tbody.textContent : "";
                    }
                """)
                if new_content != old_content:
                    time.sleep(1)  # Extra settle time
                    return True
                time.sleep(0.5)

            logger.warning("Page content did not change after clicking next.")
            return False

        except Exception as e:
            logger.debug(f"Next page error: {e}")
            return False

    def _fill_field(self, selectors: list[str], value: str, description: str) -> bool:
        """Fill the first visible field matching any selector."""
        for sel in selectors:
            try:
                field = self.page.locator(sel).first
                if field.is_visible(timeout=3000):
                    field.click()
                    field.fill(value)
                    return True
            except Exception:
                continue
        return False

    def _click_first(self, selectors: list[str], description: str) -> bool:
        """Click the first visible element matching any selector."""
        for sel in selectors:
            try:
                el = self.page.locator(sel).first
                if el.is_visible(timeout=3000):
                    el.click()
                    return True
            except Exception:
                continue
        return False
