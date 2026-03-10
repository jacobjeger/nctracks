"""NCTracks Eligibility Verifier — Entry point."""

import logging
import os
import subprocess
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("nctracks_verifier.log", mode="a"),
    ],
)

logger = logging.getLogger(__name__)


def _ensure_dependencies():
    """Install missing pip packages and Playwright browsers on first run."""
    required = ["playwright", "openpyxl", "keyring"]
    missing = []
    for pkg in required:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)

    if missing:
        print(f"Installing missing packages: {', '.join(missing)}...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install"] + missing,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # Check if Playwright browsers are installed
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.executable_path
    except Exception:
        print("First run — installing browser (one-time, may take a minute)...")
        subprocess.check_call(
            [sys.executable, "-m", "playwright", "install", "chromium"],
        )
        print("Browser installed!")


def main():
    _ensure_dependencies()
    from ui import NCTracksVerifierApp
    app = NCTracksVerifierApp()
    app.run()


if __name__ == "__main__":
    main()
