#!/bin/bash
# Double-click this file to launch NCTracks Eligibility Verifier
cd "$(dirname "$0")"

# Prefer pythonw for macOS GUI apps (Tkinter needs framework Python)
if command -v pythonw3 &>/dev/null; then
    pythonw3 main.py
elif command -v pythonw &>/dev/null; then
    pythonw main.py
else
    python3 main.py
fi
