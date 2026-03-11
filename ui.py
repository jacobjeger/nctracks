"""Tkinter desktop UI for NCTracks Eligibility Verifier."""
from __future__ import annotations

import os
import platform
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
from datetime import datetime
import logging

import keyring

import config
from data import load_patients, save_results, generate_output_path, generate_template
from automation import NCTracksAutomation
from emr import PassageHealthScraper

logger = logging.getLogger(__name__)

# ─── Color palette ───
COLORS = {
    "bg": "#f5f5f7",
    "card": "#ffffff",
    "primary": "#0071e3",
    "primary_hover": "#0077ed",
    "danger": "#ff3b30",
    "warning": "#ff9500",
    "success": "#34c759",
    "text": "#1d1d1f",
    "text_secondary": "#86868b",
    "border": "#d2d2d7",
    "input_bg": "#ffffff",
    "log_bg": "#1d1d1f",
    "log_fg": "#e5e5e7",
    "log_timestamp": "#86868b",
}

FONT_FAMILY = "SF Pro Display" if platform.system() == "Darwin" else "Segoe UI"
FONT = (FONT_FAMILY, 13)
FONT_SMALL = (FONT_FAMILY, 11)
FONT_BOLD = (FONT_FAMILY, 13, "bold")
FONT_HEADING = (FONT_FAMILY, 15, "bold")
FONT_LOG = ("SF Mono" if platform.system() == "Darwin" else "Consolas", 11)


def _configure_styles():
    """Set up modern ttk styles."""
    style = ttk.Style()

    # Use clam as base — it's the most customizable cross-platform theme
    style.theme_use("clam")

    # General widget background
    style.configure(".", background=COLORS["bg"], font=FONT,
                    foreground=COLORS["text"])

    # Frames
    style.configure("TFrame", background=COLORS["bg"])
    style.configure("Card.TFrame", background=COLORS["card"],
                    relief="flat", borderwidth=0)

    # Labels
    style.configure("TLabel", background=COLORS["bg"], font=FONT,
                    foreground=COLORS["text"])
    style.configure("Card.TLabel", background=COLORS["card"])
    style.configure("Heading.TLabel", font=FONT_HEADING,
                    background=COLORS["bg"])
    style.configure("Secondary.TLabel", foreground=COLORS["text_secondary"],
                    background=COLORS["bg"], font=FONT_SMALL)
    style.configure("Status.TLabel", foreground=COLORS["primary"],
                    background=COLORS["bg"], font=FONT_SMALL)
    style.configure("CardSecondary.TLabel", foreground=COLORS["text_secondary"],
                    background=COLORS["card"], font=FONT_SMALL)
    style.configure("CardStatus.TLabel", foreground=COLORS["primary"],
                    background=COLORS["card"], font=FONT_SMALL)

    # LabelFrames
    style.configure("TLabelframe", background=COLORS["card"],
                    foreground=COLORS["text"], relief="flat",
                    borderwidth=1, bordercolor=COLORS["border"])
    style.configure("TLabelframe.Label", background=COLORS["card"],
                    font=FONT_BOLD, foreground=COLORS["text"])

    # Entries
    style.configure("TEntry", fieldbackground=COLORS["input_bg"],
                    borderwidth=1, relief="solid", padding=(8, 6))
    style.map("TEntry",
              bordercolor=[("focus", COLORS["primary"]),
                           ("!focus", COLORS["border"])])

    # Buttons — default
    style.configure("TButton", font=FONT, padding=(16, 8),
                    borderwidth=1, relief="flat",
                    background=COLORS["card"], foreground=COLORS["text"])
    style.map("TButton",
              background=[("active", COLORS["border"]),
                          ("disabled", "#e5e5ea")],
              foreground=[("disabled", COLORS["text_secondary"])])

    # Primary button (blue)
    style.configure("Primary.TButton", font=FONT_BOLD,
                    background=COLORS["primary"], foreground="#ffffff",
                    borderwidth=0, padding=(20, 10))
    style.map("Primary.TButton",
              background=[("active", COLORS["primary_hover"]),
                          ("disabled", "#a1c4fd")],
              foreground=[("disabled", "#ffffff")])

    # Danger button (red)
    style.configure("Danger.TButton",
                    background=COLORS["danger"], foreground="#ffffff",
                    borderwidth=0, padding=(16, 8))
    style.map("Danger.TButton",
              background=[("active", "#ff453a"), ("disabled", "#e5e5ea")],
              foreground=[("disabled", COLORS["text_secondary"])])

    # Checkbuttons
    style.configure("TCheckbutton", background=COLORS["card"], font=FONT_SMALL)
    style.configure("Card.TCheckbutton", background=COLORS["card"])

    # Radiobuttons
    style.configure("TRadiobutton", background=COLORS["card"], font=FONT)
    style.configure("Card.TRadiobutton", background=COLORS["card"])

    # Progressbar
    style.configure("TProgressbar", troughcolor=COLORS["border"],
                    background=COLORS["primary"], thickness=6,
                    borderwidth=0)

    # Separator
    style.configure("TSeparator", background=COLORS["border"])


class NCTracksVerifierApp:
    """Main application window."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("NCTracks Eligibility Verifier")
        self.root.geometry("820x780")
        self.root.resizable(True, True)
        self.root.configure(bg=COLORS["bg"])

        # macOS-specific window appearance
        if platform.system() == "Darwin":
            try:
                self.root.tk.call("::tk::unsupported::MacWindowStyle",
                                  "style", self.root._w, "moveableModal", "")
            except tk.TclError:
                pass

        _configure_styles()

        self.automation: NCTracksAutomation | None = None
        self.worker_thread: threading.Thread | None = None
        self.patients: list[dict] = []
        self.patient_file_path = ""

        self._build_ui()
        self._load_saved_credentials()

    def _make_card(self, parent, title: str) -> ttk.Frame:
        """Create a card-style container with a title."""
        outer = ttk.Frame(parent, style="TFrame")
        outer.pack(fill=tk.X, pady=(0, 12))

        ttk.Label(outer, text=title, style="Heading.TLabel").pack(
            anchor=tk.W, pady=(0, 6))

        card = ttk.Frame(outer, style="Card.TFrame")
        card.pack(fill=tk.X)

        # Draw rounded border via canvas trick — or just use padding
        inner = ttk.Frame(card, style="Card.TFrame", padding=16)
        inner.pack(fill=tk.X)

        return inner

    def _build_ui(self):
        """Build the application UI."""
        # Scrollable main area
        main_frame = ttk.Frame(self.root, padding=(24, 16, 24, 16))
        main_frame.pack(fill=tk.BOTH, expand=True)

        # === EMR Credentials ===
        emr_card = self._make_card(main_frame, "EMR Credentials")

        row = ttk.Frame(emr_card, style="Card.TFrame")
        row.pack(fill=tk.X, pady=(0, 8))
        ttk.Label(row, text="Email", style="Card.TLabel", width=10).pack(
            side=tk.LEFT)
        self.emr_email_var = tk.StringVar()
        self.emr_email_entry = ttk.Entry(row, textvariable=self.emr_email_var)
        self.emr_email_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0))

        row2 = ttk.Frame(emr_card, style="Card.TFrame")
        row2.pack(fill=tk.X, pady=(0, 8))
        ttk.Label(row2, text="Password", style="Card.TLabel", width=10).pack(
            side=tk.LEFT)
        self.emr_password_var = tk.StringVar()
        self.emr_password_entry = ttk.Entry(
            row2, textvariable=self.emr_password_var, show="*")
        self.emr_password_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0))

        self.save_emr_creds_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(emr_card, text="Save credentials securely",
                         variable=self.save_emr_creds_var,
                         style="Card.TCheckbutton").pack(anchor=tk.W)

        # === NCTracks Credentials ===
        nct_card = self._make_card(main_frame, "NCTracks Credentials")

        row3 = ttk.Frame(nct_card, style="Card.TFrame")
        row3.pack(fill=tk.X, pady=(0, 8))
        ttk.Label(row3, text="Username", style="Card.TLabel", width=10).pack(
            side=tk.LEFT)
        self.username_var = tk.StringVar()
        self.username_entry = ttk.Entry(row3, textvariable=self.username_var)
        self.username_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0))

        row4 = ttk.Frame(nct_card, style="Card.TFrame")
        row4.pack(fill=tk.X, pady=(0, 8))
        ttk.Label(row4, text="Password", style="Card.TLabel", width=10).pack(
            side=tk.LEFT)
        self.password_var = tk.StringVar()
        self.password_entry = ttk.Entry(
            row4, textvariable=self.password_var, show="*")
        self.password_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0))

        self.save_creds_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(nct_card, text="Save credentials securely",
                         variable=self.save_creds_var,
                         style="Card.TCheckbutton").pack(anchor=tk.W)

        # === Client Source ===
        src_card = self._make_card(main_frame, "Client Source")

        self.source_var = tk.StringVar(value="emr")
        radio_row = ttk.Frame(src_card, style="Card.TFrame")
        radio_row.pack(fill=tk.X, pady=(0, 8))
        ttk.Radiobutton(radio_row, text="Scrape from EMR",
                         variable=self.source_var, value="emr",
                         command=self._toggle_source,
                         style="Card.TRadiobutton").pack(side=tk.LEFT)
        ttk.Radiobutton(radio_row, text="Load from File",
                         variable=self.source_var, value="file",
                         command=self._toggle_source,
                         style="Card.TRadiobutton").pack(side=tk.LEFT, padx=(24, 0))

        self.file_frame = ttk.Frame(src_card, style="Card.TFrame")
        self.file_frame.pack(fill=tk.X, pady=(0, 4))

        self.file_path_var = tk.StringVar()
        ttk.Entry(self.file_frame, textvariable=self.file_path_var,
                   state="readonly").pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.browse_btn = ttk.Button(self.file_frame, text="Browse...",
                                      command=self._browse_file)
        self.browse_btn.pack(side=tk.LEFT, padx=(8, 0))
        self.template_btn = ttk.Button(self.file_frame, text="Download Template",
                                        command=self._download_template)
        self.template_btn.pack(side=tk.LEFT, padx=(8, 0))

        self.patient_count_var = tk.StringVar(value="")
        ttk.Label(src_card, textvariable=self.patient_count_var,
                   style="CardSecondary.TLabel").pack(anchor=tk.W, pady=(4, 0))

        self._toggle_source()

        # === Action Buttons ===
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X, pady=(4, 12))

        self.run_btn = ttk.Button(btn_frame, text="Run Verification",
                                   command=self._start_run,
                                   style="Primary.TButton")
        self.run_btn.pack(side=tk.LEFT)

        self.test_btn = ttk.Button(btn_frame, text="Test Login",
                                    command=self._test_login)
        self.test_btn.pack(side=tk.LEFT, padx=(12, 0))

        self.show_browser_btn = ttk.Button(
            btn_frame, text="Show Browser",
            command=self._toggle_browser, state=tk.DISABLED,
        )
        self.show_browser_btn.pack(side=tk.LEFT, padx=(12, 0))

        # Right-aligned stop/abort
        self.abort_btn = ttk.Button(btn_frame, text="Abort",
                                     command=self._abort_run,
                                     state=tk.DISABLED,
                                     style="Danger.TButton")
        self.abort_btn.pack(side=tk.RIGHT)

        self.stop_btn = ttk.Button(btn_frame, text="Stop",
                                    command=self._stop_run, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.RIGHT, padx=(0, 8))

        # === Progress ===
        progress_frame = ttk.Frame(main_frame)
        progress_frame.pack(fill=tk.X, pady=(0, 12))

        phase_row = ttk.Frame(progress_frame)
        phase_row.pack(fill=tk.X)
        self.phase_var = tk.StringVar(value="Ready")
        ttk.Label(phase_row, textvariable=self.phase_var,
                   font=FONT_BOLD).pack(side=tk.LEFT)
        self.count_var = tk.StringVar(value="")
        ttk.Label(phase_row, textvariable=self.count_var,
                   style="Secondary.TLabel").pack(side=tk.RIGHT)

        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(
            progress_frame, variable=self.progress_var, maximum=100,
        )
        self.progress_bar.pack(fill=tk.X, pady=(6, 4))

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(progress_frame, textvariable=self.status_var,
                   style="Status.TLabel").pack(anchor=tk.W)

        # === Log Output ===
        log_label_frame = ttk.Frame(main_frame)
        log_label_frame.pack(fill=tk.X, pady=(0, 4))
        ttk.Label(log_label_frame, text="Log", style="Heading.TLabel").pack(
            anchor=tk.W)

        log_container = tk.Frame(main_frame, bg=COLORS["log_bg"],
                                  highlightthickness=0, bd=0)
        log_container.pack(fill=tk.BOTH, expand=True)

        self.log_text = scrolledtext.ScrolledText(
            log_container, height=10, state=tk.DISABLED, wrap=tk.WORD,
            font=FONT_LOG, bg=COLORS["log_bg"], fg=COLORS["log_fg"],
            insertbackground=COLORS["log_fg"], selectbackground=COLORS["primary"],
            relief="flat", borderwidth=8, padx=8, pady=8,
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)

    def _toggle_source(self):
        """Show/hide file selection based on source mode."""
        if self.source_var.get() == "emr":
            self.file_frame.pack_forget()
            self.patient_count_var.set("Clients will be scraped from EMR")
        else:
            self.file_frame.pack(fill=tk.X, pady=(0, 4))
            if self.patients:
                self.patient_count_var.set(f"{len(self.patients)} clients loaded")
            else:
                self.patient_count_var.set("No file loaded")

    def _load_saved_credentials(self):
        """Load saved credentials from keyring."""
        try:
            username = keyring.get_password(config.KEYRING_SERVICE, "username")
            password = keyring.get_password(config.KEYRING_SERVICE, "password")
            emr_email = keyring.get_password(config.KEYRING_SERVICE, "emr_email")
            emr_password = keyring.get_password(config.KEYRING_SERVICE, "emr_password")
            if username:
                self.username_var.set(username)
            if password:
                self.password_var.set(password)
            if emr_email:
                self.emr_email_var.set(emr_email)
            if emr_password:
                self.emr_password_var.set(emr_password)
        except Exception as e:
            logger.debug(f"Could not load saved credentials: {e}")

    def _save_credentials(self):
        """Save credentials to keyring."""
        if self.save_creds_var.get():
            try:
                keyring.set_password(config.KEYRING_SERVICE, "username",
                                     self.username_var.get())
                keyring.set_password(config.KEYRING_SERVICE, "password",
                                     self.password_var.get())
            except Exception as e:
                logger.warning(f"Could not save NCTracks credentials: {e}")
        if self.save_emr_creds_var.get():
            try:
                keyring.set_password(config.KEYRING_SERVICE, "emr_email",
                                     self.emr_email_var.get())
                keyring.set_password(config.KEYRING_SERVICE, "emr_password",
                                     self.emr_password_var.get())
            except Exception as e:
                logger.warning(f"Could not save EMR credentials: {e}")

    def _browse_file(self):
        """Open file dialog to select patient list."""
        path = filedialog.askopenfilename(
            title="Select Client List",
            filetypes=[
                ("Excel files", "*.xlsx"),
                ("CSV files", "*.csv"),
                ("All files", "*.*"),
            ],
        )
        if path:
            self.file_path_var.set(path)
            self.patient_file_path = path
            try:
                self.patients = load_patients(path)
                self.patient_count_var.set(f"{len(self.patients)} clients loaded")
                self._log(f"Loaded {len(self.patients)} clients from {os.path.basename(path)}")
            except Exception as e:
                self.patient_count_var.set("Error loading file")
                messagebox.showerror("File Error", str(e))

    def _download_template(self):
        """Save a blank patient list template file."""
        path = filedialog.asksaveasfilename(
            title="Save Client List Template",
            defaultextension=".xlsx",
            initialfile="client_template.xlsx",
            filetypes=[("Excel files", "*.xlsx")],
        )
        if path:
            try:
                generate_template(path)
                self._log(f"Template saved to {path}")
                messagebox.showinfo(
                    "Template Saved",
                    f"Client list template saved to:\n{path}\n\n"
                    "Fill in the Medicaid ID column (required).\n"
                    "First Name, Last Name, and DOB are optional.",
                )
            except Exception as e:
                messagebox.showerror("Error", f"Could not save template: {e}")

    def _validate_inputs(self) -> bool:
        """Validate that all required inputs are provided."""
        if not self.username_var.get().strip():
            messagebox.showwarning("Missing Input", "Please enter your NCID username.")
            return False
        if not self.password_var.get().strip():
            messagebox.showwarning("Missing Input", "Please enter your NCID password.")
            return False
        if self.source_var.get() == "emr":
            if not self.emr_email_var.get().strip():
                messagebox.showwarning("Missing Input", "Please enter your EMR email.")
                return False
            if not self.emr_password_var.get().strip():
                messagebox.showwarning("Missing Input", "Please enter your EMR password.")
                return False
        return True

    def _start_run(self):
        """Start the eligibility verification run."""
        if not self._validate_inputs():
            return
        if self.source_var.get() == "file" and not self.patients:
            messagebox.showwarning("No Clients", "Please load a client list first.")
            return

        self._save_credentials()
        self._set_running(True)
        self.worker_thread = threading.Thread(target=self._run_verification, daemon=True)
        self.worker_thread.start()

    def _test_login(self):
        """Test login only (no patient verification)."""
        if not self._validate_inputs():
            return

        self._save_credentials()
        self._set_running(True)
        self.worker_thread = threading.Thread(target=self._run_test_login, daemon=True)
        self.worker_thread.start()

    def _stop_run(self):
        """Stop the running verification gracefully."""
        if self.automation:
            self.automation.request_stop()
            self._log("Stop requested — finishing current client...")

    def _abort_run(self):
        """Immediately abort all processing."""
        self._log("ABORT — stopping immediately...")
        if self.automation:
            self.automation.request_abort()
            try:
                self.automation.close()
            except Exception:
                pass

    def _toggle_browser(self):
        """Show or hide the browser window on demand."""
        if not self.automation:
            return
        if getattr(self, "_browser_visible", False):
            self.automation._hide_browser()
            self.show_browser_btn.config(text="Show Browser")
            self._browser_visible = False
        else:
            self.automation._show_browser()
            self.show_browser_btn.config(text="Hide Browser")
            self._browser_visible = True

    def _set_running(self, running: bool):
        """Toggle UI state between running and idle."""
        state = tk.DISABLED if running else tk.NORMAL
        self.run_btn.config(state=state)
        self.test_btn.config(state=state)
        self.stop_btn.config(state=tk.NORMAL if running else tk.DISABLED)
        self.abort_btn.config(state=tk.NORMAL if running else tk.DISABLED)
        self.show_browser_btn.config(state=tk.NORMAL if running else tk.DISABLED)
        self.emr_email_entry.config(state=state)
        self.emr_password_entry.config(state=state)
        self.username_entry.config(state=state)
        self.password_entry.config(state=state)

    def _update_phase(self, phase: str, current: int = 0, total: int = 0):
        """Update phase label and progress bar (thread-safe)."""
        def _do():
            self.phase_var.set(phase)
            if total > 0:
                self.count_var.set(f"{current} / {total}")
                self.progress_var.set((current / total) * 100)
            else:
                self.count_var.set("")
                self.progress_var.set(0)
        self.root.after(0, _do)

    def _update_status(self, message: str):
        """Update status label (thread-safe)."""
        self.root.after(0, lambda: self.status_var.set(message))
        self._log(message)

    def _log(self, message: str):
        """Append timestamped message to log (thread-safe)."""
        timestamp = datetime.now().strftime("%H:%M:%S")

        def _append():
            self.log_text.config(state=tk.NORMAL)
            self.log_text.insert(tk.END, f"{timestamp}  {message}\n")
            self.log_text.see(tk.END)
            self.log_text.config(state=tk.DISABLED)

        self.root.after(0, _append)

    def _show_mfa_alert(self):
        """Show MFA notification popup."""
        self.root.after(
            0,
            lambda: messagebox.showinfo(
                "MFA Required",
                "Multi-factor authentication is required.\n\n"
                "Please complete MFA in the browser window.\n"
                "The automation will continue automatically after MFA is completed.",
            ),
        )

    def _show_captcha_alert(self):
        """Show CAPTCHA notification popup."""
        self.root.after(
            0,
            lambda: messagebox.showwarning(
                "CAPTCHA Detected",
                "A CAPTCHA has been detected!\n\n"
                "Please solve the CAPTCHA in the browser window.\n"
                "The automation will resume automatically after it's solved.",
            ),
        )

    def _run_test_login(self):
        """Test login flow only."""
        try:
            self.automation = NCTracksAutomation(
                username=self.username_var.get().strip(),
                password=self.password_var.get().strip(),
                on_status=self._update_status,
                on_mfa_required=self._show_mfa_alert,
                on_captcha_detected=self._show_captcha_alert,
            )
            self._update_phase("Testing Login...")
            self.automation.start_browser()

            # Test EMR login if in EMR mode
            if self.source_var.get() == "emr":
                self._update_phase("EMR Login")
                emr = PassageHealthScraper(self.automation.page,
                                           on_status=self._update_status)
                success = emr.login(
                    self.emr_email_var.get().strip(),
                    self.emr_password_var.get().strip(),
                )
                if success:
                    self._update_status("EMR login successful!")
                else:
                    self._update_status("EMR login failed.")
                    return

            # Test NCTracks login
            self._update_phase("NCTracks Login")
            success = self.automation.login()

            if success:
                self._update_status("All login tests successful!")
                self.root.after(
                    0,
                    lambda: messagebox.showinfo(
                        "Success",
                        "Login test successful!\nThe browser will remain open."
                    ),
                )
            else:
                self._update_status("NCTracks login test failed.")

        except Exception as e:
            self._update_status(f"Error: {e}")
            logger.exception("Test login error")
        finally:
            self._update_phase("Ready")
            self._set_running_after()

    def _run_verification(self):
        """Run the full verification process."""
        try:
            self.automation = NCTracksAutomation(
                username=self.username_var.get().strip(),
                password=self.password_var.get().strip(),
                on_status=self._update_status,
                on_mfa_required=self._show_mfa_alert,
                on_captcha_detected=self._show_captcha_alert,
            )

            self.automation.start_browser()

            # -- Phase 1: EMR Scrape (if EMR mode) --
            if self.source_var.get() == "emr":
                self._update_phase("EMR Login")

                emr = PassageHealthScraper(self.automation.page,
                                           on_status=self._update_status)

                if not emr.login(self.emr_email_var.get().strip(),
                                  self.emr_password_var.get().strip()):
                    self._update_status("EMR login failed.")
                    return

                self._update_phase("EMR Scrape")
                self.patients = emr.scrape_funding_sources()

                if not self.patients:
                    self._update_status("No clients found in EMR. Stopping.")
                    return

                self._update_status(f"Scraped {len(self.patients)} clients from EMR.")
                self.root.after(0, lambda: self.patient_count_var.set(
                    f"{len(self.patients)} clients scraped from EMR"))

            if not self.patients:
                self._update_status("No clients to verify.")
                return

            if self.automation._abort_requested:
                self._update_status("Aborted.")
                return

            # -- Phase 2: NCTracks Login --
            self._update_phase("NCTracks Login")

            if not self.automation.login():
                self._update_status("NCTracks login failed. Please check credentials.")
                return

            if self.automation._abort_requested:
                self._update_status("Aborted.")
                return

            # -- Phase 3: Verification --
            self._update_phase("Verification", 0, len(self.patients))
            self.automation.navigate_to_eligibility()

            def on_progress(current, total):
                self._update_phase("Verification", current, total)

            results = self.automation.run_batch(self.patients, on_progress=on_progress)

            # -- Phase 4: Save Results --
            if results:
                output_path = generate_output_path(
                    self.patient_file_path if self.source_var.get() == "file" else None
                )
                save_results(results, output_path)

                eligible = sum(1 for r in results
                               if r.get("status") in ("ELIGIBLE", "MANAGED CARE"))
                errors = sum(1 for r in results if r.get("status") == "ERROR")
                payer_changes = sum(1 for r in results
                                    if r.get("payer_changed_next") == "YES")

                self._update_phase("Complete")
                self._update_status(f"Done! Results saved to: {output_path}")

                summary = (
                    f"Verification complete!\n\n"
                    f"Processed: {len(results)} clients\n"
                    f"Eligible: {eligible}\n"
                    f"Errors: {errors}\n"
                )
                if payer_changes > 0:
                    summary += f"Payer Changes (Next Month): {payer_changes}\n"
                summary += f"\nResults saved to:\n{output_path}"

                self.root.after(
                    0,
                    lambda: messagebox.showinfo("Complete", summary),
                )

        except Exception as e:
            self._update_status(f"Error: {e}")
            logger.exception("Verification error")
        finally:
            if self.automation:
                self.automation.close()
            self._update_phase("Ready")
            self._set_running_after()

    def _set_running_after(self):
        """Reset UI after run completes."""
        self.root.after(0, lambda: self._set_running(False))

    def run(self):
        """Start the application."""
        self.root.mainloop()
