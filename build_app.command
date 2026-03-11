#!/bin/bash
# ============================================
# Build NCTracks Verifier as a standalone .app
# Double-click this file to build the app.
# Requires: macOS with Xcode Command Line Tools
# ============================================

set -e
cd "$(dirname "$0")"
APP_DIR="$(pwd)"

echo "============================================"
echo "  Building NCTracks Verifier Standalone App"
echo "============================================"
echo ""

# ─── Ensure Homebrew ───
if ! command -v brew &>/dev/null; then
    echo ">> Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
fi
if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# ─── Ensure Python 3.11+ ───
PYTHON=""
for p in python3.13 python3.12 python3.11 python3; do
    if command -v "$p" &>/dev/null; then
        ver=$("$p" -c "import sys; print(sys.version_info.minor)" 2>/dev/null)
        maj=$("$p" -c "import sys; print(sys.version_info.major)" 2>/dev/null)
        if [ "$maj" = "3" ] && [ "$ver" -ge 11 ] 2>/dev/null; then
            PYTHON="$p"
            break
        fi
    fi
done
if [ -z "$PYTHON" ]; then
    echo ">> Installing Python 3.12..."
    brew install python@3.12
    PYTHON="/opt/homebrew/bin/python3.12"
    [ ! -x "$PYTHON" ] && PYTHON="/usr/local/bin/python3.12"
fi
echo ">> Using Python: $PYTHON ($($PYTHON --version))"

# ─── Create build venv ───
echo ">> Creating build environment..."
VENV="$APP_DIR/.build_venv"
rm -rf "$VENV"
"$PYTHON" -m venv "$VENV"
source "$VENV/bin/activate"

# ─── Install dependencies ───
echo ">> Installing dependencies..."
pip install --upgrade pip --quiet
pip install -r requirements.txt --quiet
pip install pyinstaller --quiet

# tkinter check — PyInstaller bundles it from the system
python -c "import tkinter" 2>/dev/null || {
    echo ">> Installing tkinter..."
    brew install python-tk@3.12 2>/dev/null || brew install python-tk 2>/dev/null || true
}

# ─── Build with PyInstaller ───
echo ">> Building standalone app..."

# Find the playwright package location for bundling
PW_PATH=$(python -c "import playwright; import os; print(os.path.dirname(playwright.__file__))")

pyinstaller \
    --name "NCTracks Verifier" \
    --windowed \
    --onedir \
    --noconfirm \
    --clean \
    --add-data "config.py:." \
    --add-data "automation.py:." \
    --add-data "ui.py:." \
    --add-data "data.py:." \
    --add-data "emr.py:." \
    --hidden-import "playwright" \
    --hidden-import "playwright.sync_api" \
    --hidden-import "playwright._impl" \
    --hidden-import "openpyxl" \
    --hidden-import "keyring" \
    --hidden-import "keyring.backends" \
    --hidden-import "keyring.backends.macOS" \
    --collect-all "playwright" \
    --collect-all "keyring" \
    --osx-bundle-identifier "com.nctracks.verifier" \
    main.py

# ─── Move built app to project root ───
BUILT_APP="$APP_DIR/dist/NCTracks Verifier.app"
FINAL_APP="$APP_DIR/NCTracks Verifier.app"

if [ -d "$BUILT_APP" ]; then
    rm -rf "$FINAL_APP"
    mv "$BUILT_APP" "$FINAL_APP"
    echo ""
    echo "============================================"
    echo "  BUILD SUCCESSFUL!"
    echo ""
    echo "  App location:"
    echo "  $FINAL_APP"
    echo ""
    echo "  You can drag it to Applications or"
    echo "  double-click to run it directly."
    echo ""
    echo "  Note: Google Chrome must be installed."
    echo "============================================"
else
    echo ""
    echo "  BUILD FAILED — check output above."
    echo ""
fi

# ─── Cleanup ───
rm -rf "$APP_DIR/build" "$APP_DIR/dist" "$APP_DIR/.build_venv" "$APP_DIR/NCTracks Verifier.spec"

read -p "Press Enter to close..."
