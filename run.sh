#!/bin/bash
echo "=== NCTracks Eligibility Verifier ==="
cd "$(dirname "$0")"
python3 main.py || python main.py
