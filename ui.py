"""Tkinter desktop UI for NCTracks Eligibility Verifier."""

import os
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import logging

import keyring

import config
from data import load_patients, save_results, generate_output_path
from automation import NCTracksAutomation

logger = logging.getLogger(__name__)


class NCTracksVerifierApp:
    """Main application window."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("NCTracks Eligibility Verifier")
        self.root.geometry("750x650")
        self.root.resizable(True, True)

        self.automation: NCTracksAutomation | None = None
        self.worker_thread: threading.Thread | None = None
        self.patients: list[dict] = []
        self.patient_file_path = ""

        self._build_ui()
        self._load_saved_credentials()

    def _build_ui(self):
        """Build the application UI."""
        # Main container
        main_frame = ttk.Frame(self.root, padding=10)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # === Credentials Section ===
        cred_frame = ttk.LabelFrame(main_frame, text="NCTracks Credentials", padding=10)
        cred_frame.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(cred_frame, text="NCID Username:").grid(row=0, column=0, sticky=tk.W, pady=2)
        self.username_var = tk.StringVar()
        self.username_entry = ttk.Entry(cred_frame, textvariable=self.username_var, width=40)
        self.username_entry.grid(row=0, column=1, sticky=tk.EW, padx=(10, 0), pady=2)

        ttk.Label(cred_frame, text="Password:").grid(row=1, column=0, sticky=tk.W, pady=2)
        self.password_var = tk.StringVar()
        self.password_entry = ttk.Entry(cred_frame, textvariable=self.password_var, width=40, show="*")
        self.password_entry.grid(row=1, column=1, sticky=tk.EW, padx=(10, 0), pady=2)

        self.save_creds_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            cred_frame, text="Save credentials securely", variable=self.save_creds_var
        ).grid(row=2, column=1, sticky=tk.W, padx=(10, 0), pady=2)

        cred_frame.columnconfigure(1, weight=1)

        # === Patient File Section ===
        file_frame = ttk.LabelFrame(main_frame, text="Patient List", padding=10)
        file_frame.pack(fill=tk.X, pady=(0, 10))

        self.file_path_var = tk.StringVar()
        ttk.Entry(file_frame, textvariable=self.file_path_var, state="readonly").pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        ttk.Button(file_frame, text="Browse...", command=self._browse_file).pack(
            side=tk.LEFT, padx=(10, 0)
        )

        # Patient count label
        self.patient_count_var = tk.StringVar(value="No file loaded")
        ttk.Label(main_frame, textvariable=self.patient_count_var).pack(anchor=tk.W)

        # === Control Buttons ===
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X, pady=10)

        self.run_btn = ttk.Button(btn_frame, text="Run Verification", command=self._start_run)
        self.run_btn.pack(side=tk.LEFT)

        self.stop_btn = ttk.Button(
            btn_frame, text="Stop", command=self._stop_run, state=tk.DISABLED
        )
        self.stop_btn.pack(side=tk.LEFT, padx=(10, 0))

        self.test_btn = ttk.Button(
            btn_frame, text="Test Login Only", command=self._test_login
        )
        self.test_btn.pack(side=tk.LEFT, padx=(10, 0))

        # === Progress ===
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(
            main_frame, variable=self.progress_var, maximum=100
        )
        self.progress_bar.pack(fill=tk.X, pady=(0, 5))

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(main_frame, textvariable=self.status_var, foreground="blue").pack(
            anchor=tk.W
        )

        # === Log Output ===
        log_frame = ttk.LabelFrame(main_frame, text="Log", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=True, pady=(10, 0))

        self.log_text = scrolledtext.ScrolledText(
            log_frame, height=12, state=tk.DISABLED, wrap=tk.WORD, font=("Consolas", 9)
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)

    def _load_saved_credentials(self):
        """Load saved credentials from keyring."""
        try:
            username = keyring.get_password(config.KEYRING_SERVICE, "username")
            password = keyring.get_password(config.KEYRING_SERVICE, "password")
            if username:
                self.username_var.set(username)
            if password:
                self.password_var.set(password)
        except Exception as e:
            logger.debug(f"Could not load saved credentials: {e}")

    def _save_credentials(self):
        """Save credentials to keyring."""
        if self.save_creds_var.get():
            try:
                keyring.set_password(
                    config.KEYRING_SERVICE, "username", self.username_var.get()
                )
                keyring.set_password(
                    config.KEYRING_SERVICE, "password", self.password_var.get()
                )
            except Exception as e:
                logger.warning(f"Could not save credentials: {e}")

    def _browse_file(self):
        """Open file dialog to select patient list."""
        path = filedialog.askopenfilename(
            title="Select Patient List",
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
                self.patient_count_var.set(f"{len(self.patients)} patients loaded")
                self._log(f"Loaded {len(self.patients)} patients from {os.path.basename(path)}")
            except Exception as e:
                self.patient_count_var.set("Error loading file")
                messagebox.showerror("File Error", str(e))

    def _validate_inputs(self) -> bool:
        """Validate that all required inputs are provided."""
        if not self.username_var.get().strip():
            messagebox.showwarning("Missing Input", "Please enter your NCID username.")
            return False
        if not self.password_var.get().strip():
            messagebox.showwarning("Missing Input", "Please enter your password.")
            return False
        return True

    def _start_run(self):
        """Start the eligibility verification run."""
        if not self._validate_inputs():
            return
        if not self.patients:
            messagebox.showwarning("No Patients", "Please load a patient list first.")
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
        """Stop the running verification."""
        if self.automation:
            self.automation.request_stop()
            self._log("Stop requested — finishing current patient...")

    def _set_running(self, running: bool):
        """Toggle UI state between running and idle."""
        state = tk.DISABLED if running else tk.NORMAL
        self.run_btn.config(state=state)
        self.test_btn.config(state=state)
        self.stop_btn.config(state=tk.NORMAL if running else tk.DISABLED)

    def _update_status(self, message: str):
        """Update status label (thread-safe)."""
        self.root.after(0, lambda: self.status_var.set(message))
        self._log(message)

    def _log(self, message: str):
        """Append message to log (thread-safe)."""
        def _append():
            self.log_text.config(state=tk.NORMAL)
            self.log_text.insert(tk.END, message + "\n")
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
            self.automation.start_browser()
            success = self.automation.login()

            if success:
                self._update_status("Login test successful!")
                self.root.after(
                    0,
                    lambda: messagebox.showinfo(
                        "Success", "Login test successful!\nThe browser will remain open."
                    ),
                )
            else:
                self._update_status("Login test failed.")

        except Exception as e:
            self._update_status(f"Error: {e}")
            logger.exception("Test login error")
        finally:
            # Don't close browser after test so user can inspect
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

            # Start browser and login
            self.automation.start_browser()
            if not self.automation.login():
                self._update_status("Login failed. Please check credentials.")
                return

            # Navigate to eligibility page
            self.automation.navigate_to_eligibility()

            # Run batch verification
            total = len(self.patients)
            results = []

            for idx, patient in enumerate(self.patients):
                if self.automation._stop_requested:
                    self._update_status(f"Stopped after {idx}/{total}")
                    break

                # Update progress
                progress = ((idx + 1) / total) * 100
                self.root.after(0, lambda p=progress: self.progress_var.set(p))

                result = self.automation.check_patient(patient)
                results.append(result)

            # Save results
            if results:
                output_path = generate_output_path(self.patient_file_path)
                save_results(results, output_path)
                self._update_status(f"Done! Results saved to: {output_path}")
                self.root.after(
                    0,
                    lambda: messagebox.showinfo(
                        "Complete",
                        f"Verification complete!\n\n"
                        f"Processed: {len(results)} patients\n"
                        f"Results saved to:\n{output_path}",
                    ),
                )

        except Exception as e:
            self._update_status(f"Error: {e}")
            logger.exception("Verification error")
        finally:
            if self.automation:
                self.automation.close()
            self._set_running_after()

    def _set_running_after(self):
        """Reset UI after run completes."""
        self.root.after(0, lambda: self._set_running(False))

    def run(self):
        """Start the application."""
        self.root.mainloop()
