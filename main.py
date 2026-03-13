"""NCTracks Eligibility Verifier — Entry point."""

import logging
import os
import subprocess
import sys

# When running as a PyInstaller bundle, use the app's directory for logs
if getattr(sys, 'frozen', False):
    _app_dir = os.path.dirname(sys.executable)
    _log_file = os.path.join(_app_dir, "nctracks_verifier.log")
else:
    _log_file = "nctracks_verifier.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_log_file, mode="a"),
    ],
)

logger = logging.getLogger(__name__)


def _ensure_dependencies():
    """Install missing pip packages on first run (skipped in standalone mode)."""
    # Skip dependency installation when running as a bundled app
    if getattr(sys, 'frozen', False):
        return

    required = ["playwright", "openpyxl"]
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


def main():
    _ensure_dependencies()
    from ui import NCTracksVerifierApp
    app = NCTracksVerifierApp()
    app.run()


if __name__ == "__main__":
    main()
