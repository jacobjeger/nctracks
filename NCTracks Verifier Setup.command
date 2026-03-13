#!/bin/bash
# ============================================
# NCTracks Eligibility Verifier - Setup & Run
# Double-click this file to install and launch
# ============================================

clear
echo "============================================"
echo "  NCTracks Eligibility Verifier"
echo "  Setting up... this may take a few minutes"
echo "  on first run. Please be patient."
echo "============================================"
echo ""

# Go to the folder where this script lives
cd "$(dirname "$0")"

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    echo ">> Installing Homebrew (Mac package manager)..."
    echo "   You may be asked for your Mac password."
    echo ""
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add Homebrew to PATH for Apple Silicon Macs
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
fi

# Ensure brew is in PATH
if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Check if Python 3.11+ is installed
PYTHON=""
for p in python3.11 python3.12 python3.13 python3; do
    if command -v "$p" &> /dev/null; then
        version=$("$p" -c "import sys; print(sys.version_info.minor)")
        major=$("$p" -c "import sys; print(sys.version_info.major)")
        if [ "$major" = "3" ] && [ "$version" -ge 11 ]; then
            PYTHON="$p"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo ">> Installing Python 3.12..."
    brew install python@3.12
    PYTHON="python3.12"

    # Add to PATH
    if [ -f /opt/homebrew/bin/python3.12 ]; then
        PYTHON="/opt/homebrew/bin/python3.12"
    elif [ -f /usr/local/bin/python3.12 ]; then
        PYTHON="/usr/local/bin/python3.12"
    fi
fi

echo ">> Using Python: $PYTHON"

# Install Python dependencies if not already installed
if ! "$PYTHON" -c "import playwright" &> /dev/null; then
    echo ">> Installing required packages (first time only)..."
    "$PYTHON" -m pip install --upgrade pip --quiet
    "$PYTHON" -m pip install -r requirements.txt --quiet
fi

# Install tkinter if needed (via Homebrew's python-tk)
if ! "$PYTHON" -c "import tkinter" &> /dev/null; then
    echo ">> Installing GUI toolkit..."
    brew install python-tk@3.12 2>/dev/null || brew install python-tk 2>/dev/null || true
fi

# Check that Google Chrome is installed
if [ ! -d "/Applications/Google Chrome.app" ]; then
    echo ""
    echo "WARNING: Google Chrome is required but not installed."
    echo "Please install it from https://www.google.com/chrome/"
    echo ""
fi

echo ""
echo ">> Launching NCTracks Verifier..."
echo ""

# Run the app
"$PYTHON" main.py

# Keep window open if there was an error
if [ $? -ne 0 ]; then
    echo ""
    echo "============================================"
    echo "  Something went wrong. Please screenshot"
    echo "  this window and send it for help."
    echo "============================================"
    read -p "Press Enter to close..."
fi
