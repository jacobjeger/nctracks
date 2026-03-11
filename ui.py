"""Tkinter desktop UI for NCTracks Eligibility Verifier."""
from __future__ import annotations

import os
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


class NCTracksVerifierApp:
    """Main application window."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("NCTracks Eligibility Verifier")
        self.root.geometry("800x750")
        self.root.resizable(True, True)

        self.automation: NCTracksAutomation | None = None
        self.worker_thread: threading.Thread | None = None
        self.patients: list[dict] = []
        self.patient_file_path = ""

        self._build_ui()
        self._load_saved_credentials()

    def _build_ui(self):
        """Build the application UI."""
        main_frame = ttk.Frame(self.root, padding=10)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # === EMR Credentials ===
        emr_frame = ttk.LabelFrame(main_frame, text="EMR Credentials (Passage Health)", padding=10)
        emr_frame.pack(fill=tk.X, pady=(0, 8))

        ttk.Label(emr_frame, text="Email:").grid(row=0, column=0, sticky=tk.W, pady=2)
        self.emr_email_var = tk.StringVar()
        self.emr_email_entry = ttk.Entry(emr_frame, textvariable=self.emr_email_var, width=40)
        self.emr_email_entry.grid(row=0, column=1, sticky=tk.EW, padx=(10, 0), pady=2)

        ttk.Label(emr_frame, text="Password:").grid(row=1, column=0, sticky=tk.W, pady=2)
        self.emr_password_var = tk.StringVar()
        self.emr_password_entry = ttk.Entry(emr_frame, textvariable=self.emr_password_var,
                                             width=40, show="*")
        self.emr_password_entry.grid(row=1, column=1, sticky=tk.EW, padx=(10, 0), pady=2)

        self.save_emr_creds_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(emr_frame, text="Save credentials securely",
                         variable=self.save_emr_creds_var).grid(
            row=2, column=1, sticky=tk.W, padx=(10, 0), pady=2)

        emr_frame.columnconfigure(1, weight=1)

        # === NCTracks Credentials ===
        cred_frame = ttk.LabelFrame(main_frame, text="NCTracks Credentials (NCID)", padding=10)
        cred_frame.pack(fill=tk.X, pady=(0, 8))

        ttk.Label(cred_frame, text="Username:").grid(row=0, column=0, sticky=tk.W, pady=2)
        self.username_var = tk.StringVar()
        self.username_entry = ttk.Entry(cred_frame, textvariable=self.username_var, width=40)
        self.username_entry.grid(row=0, column=1, sticky=tk.EW, padx=(10, 0), pady=2)

        ttk.Label(cred_frame, text="Password:").grid(row=1, column=0, sticky=tk.W, pady=2)
        self.password_var = tk.StringVar()
        self.password_entry = ttk.Entry(cred_frame, textvariable=self.password_var,
                                         width=40, show="*")
        self.password_entry.grid(row=1, column=1, sticky=tk.EW, padx=(10, 0), pady=2)

        self.save_creds_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(cred_frame, text="Save credentials securely",
                         variable=self.save_creds_var).grid(
            row=2, column=1, sticky=tk.W, padx=(10, 0), pady=2)

        cred_frame.columnconfigure(1, weight=1)

        # === Client Source ===
        source_frame = ttk.LabelFrame(main_frame, text="Client Source", padding=10)
        source_frame.pack(fill=tk.X, pady=(0, 8))

        self.source_var = tk.StringVar(value="emr")

        radio_frame = ttk.Frame(source_frame)
        radio_frame.pack(fill=tk.X)
        ttk.Radiobutton(radio_frame, text="Scrape from EMR",
                         variable=self.source_var, value="emr",
                         command=self._toggle_source).pack(side=tk.LEFT)
        ttk.Radiobutton(radio_frame, text="Load from File",
                         variable=self.source_var, value="file",
                         command=self._toggle_source).pack(side=tk.LEFT, padx=(20, 0))

        # File selection (hidden when EMR mode)
        self.file_frame = ttk.Frame(source_frame)
        self.file_frame.pack(fill=tk.X, pady=(8, 0))

        self.file_path_var = tk.StringVar()
        ttk.Entry(self.file_frame, textvariable=self.file_path_var,
                   state="readonly").pack(side=tk.LEFT, fill=tk.X, expand=True)

        self.browse_btn = ttk.Button(self.file_frame, text="Browse...",
                                      command=self._browse_file)
        self.browse_btn.pack(side=tk.LEFT, padx=(10, 0))

        self.template_btn = ttk.Button(self.file_frame, text="Download Template",
                                        command=self._download_template)
        self.template_btn.pack(side=tk.LEFT, padx=(10, 0))

        self.patient_count_var = tk.StringVar(value="")
        ttk.Label(source_frame, textvariable=self.patient_count_var).pack(
            anchor=tk.W, pady=(4, 0))

        self._toggle_source()  # Set initial visibility

        # === Control Buttons ===
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X, pady=8)

        self.run_btn = ttk.Button(btn_frame, text="Run Verification",
                                   command=self._start_run)
        self.run_btn.pack(side=tk.LEFT)

        self.stop_btn = ttk.Button(btn_frame, text="Stop",
                                    command=self._stop_run, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=(10, 0))

        self.abort_btn = ttk.Button(btn_frame, text="Abort",
                                     command=self._abort_run, state=tk.DISABLED)
        self.abort_btn.pack(side=tk.LEFT, padx=(10, 0))

        self.test_btn = ttk.Button(btn_frame, text="Test Login Only",
                                    command=self._test_login)
        self.test_btn.pack(side=tk.LEFT, padx=(10, 0))

        # === Progress ===
        progress_frame = ttk.LabelFrame(main_frame, text="Progress", padding=8)
        progress_frame.pack(fill=tk.X, pady=(0, 8))

        phase_row = ttk.Frame(progress_frame)
        phase_row.pack(fill=tk.X)
        self.phase_var = tk.StringVar(value="Ready")
        ttk.Label(phase_row, textvariable=self.phase_var,
                   font=("TkDefaultFont", 10, "bold")).pack(side=tk.LEFT)
        self.count_var = tk.StringVar(value="")
        ttk.Label(phase_row, textvariable=self.count_var).pack(side=tk.RIGHT)

        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(
            progress_frame, variable=self.progress_var, maximum=100
        )
        self.progress_bar.pack(fill=tk.X, pady=(4, 2))

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(progress_frame, textvariable=self.status_var,
                   foreground="blue").pack(anchor=tk.W)

        # === Log Output ===
        log_frame = ttk.LabelFrame(main_frame, text="Log", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 0))

        self.log_text = scrolledtext.ScrolledText(
            log_frame, height=14, state=tk.DISABLED, wrap=tk.WORD,
            font=("Consolas", 9)
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)

    def _toggle_source(self):
        """Show/hide file selection based on source mode."""
        if self.source_var.get() == "emr":
            self.file_frame.pack_forget()
            self.patient_count_var.set("Clients will be scraped from EMR")
        else:
            self.file_frame.pack(fill=tk.X, pady=(8, 0))
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

    def _set_running(self, running: bool):
        """Toggle UI state between running and idle."""
        state = tk.DISABLED if running else tk.NORMAL
        self.run_btn.config(state=state)
        self.test_btn.config(state=state)
        self.stop_btn.config(state=tk.NORMAL if running else tk.DISABLED)
        self.abort_btn.config(state=tk.NORMAL if running else tk.DISABLED)
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

            # ── Phase 1: EMR Scrape (if EMR mode) ──
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

            # ── Phase 2: NCTracks Login ──
            self._update_phase("NCTracks Login")

            if not self.automation.login():
                self._update_status("NCTracks login failed. Please check credentials.")
                return

            if self.automation._abort_requested:
                self._update_status("Aborted.")
                return

            # ── Phase 3: Verification ──
            self._update_phase("Verification", 0, len(self.patients))
            self.automation.navigate_to_eligibility()

            def on_progress(current, total):
                self._update_phase("Verification", current, total)

            results = self.automation.run_batch(self.patients, on_progress=on_progress)

            # ── Phase 4: Save Results ──
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
