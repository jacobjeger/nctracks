# NCTracks Eligibility Verifier

A desktop application that automates Medicaid eligibility verification through North Carolina's [NCTracks](https://www.nctracks.nc.gov) provider portal. It pulls client lists from the Passage Health EMR, checks each client's eligibility and managing entity on NCTracks, and exports a detailed report.

## Features

- **EMR Integration** — Scrapes the Passage Health Funding Sources report to build a client list with active insurance/payer info.
- **Automated NCTracks Lookup** — Logs into the NCTracks provider portal, handles MFA, and verifies each client's Medicaid eligibility.
- **Payer Change Detection** — Compares the managing entity returned by NCTracks against the EMR funding source and flags mismatches.
- **Excel Export** — Saves results to an `.xlsx` report with columns for status, insurance type, managing entity (current & next period), payer changes, and notes.
- **Desktop GUI** — Tkinter-based interface with credential storage, live progress log, and an abort button.
- **macOS App Bundle** — Includes a build script to package the tool as a `.app` for double-click launching.

## Requirements

- Python 3.9+
- Google Chrome (the app uses the system Chrome installation via Playwright)
- Dependencies listed in `requirements.txt`:
  - `playwright` — browser automation
  - `openpyxl` — Excel file I/O

## Quick Start

```bash
# Clone the repo
git clone https://github.com/jacobjeger/nctracks.git
cd nctracks

# Install dependencies
pip install -r requirements.txt
python -m playwright install chromium

# Run
python main.py
```

On first launch the app will prompt for your NCTracks (NCID) and Passage Health credentials. These are stored locally in a `.credentials.json` file (base64-encoded, not uploaded anywhere).

### macOS

Double-click `NCTracks Verifier.app`, or run:

```bash
./run.sh
```

### Windows

```bash
run.bat
```

## Usage

1. **Enter credentials** for NCTracks and Passage Health in the Settings panel.
2. **Click "Run Verification"** — the app will:
   - Log into Passage Health and scrape your active client list.
   - Log into NCTracks, complete MFA (a browser window will appear for this step), and verify each client.
3. **Review the report** — results are saved as an Excel file in the working directory.

## Project Structure

| File | Description |
|---|---|
| `main.py` | Entry point; installs missing deps and launches the GUI |
| `ui.py` | Tkinter desktop interface |
| `automation.py` | Playwright engine for NCTracks eligibility lookups |
| `emr.py` | Passage Health EMR scraper |
| `data.py` | Patient file I/O and Excel export |
| `config.py` | URLs, timeouts, column definitions, and payer mappings |
| `build_mac_app.sh` | PyInstaller build script for macOS `.app` bundle |

## License

Private — not licensed for redistribution.
