"""Configuration constants for NCTracks Eligibility Verifier."""

# NCTracks URLs
NCTRACKS_HOME = "https://www.nctracks.nc.gov"
PROVIDER_PORTAL_LOGIN = "https://www.nctracks.nc.gov/ncmmisPortal/loginAction?flow=PP"
NCID_LOGIN_BASE = "https://login.myncid.nc.gov"
ELIGIBILITY_INQUIRY_URL = "https://www.nctracks.nc.gov/DirectConnect/Eligibility/Inquiry"

# Provider defaults for Verify Recipient form
DEFAULT_GROUP = "144862:1396570"  # Group dropdown value
DEFAULT_NPI = "1396570701"  # NPI / Atypical ID dropdown value
DOS_RANGE_DAYS = 35  # Date of Service range: today + this many days

# Timeouts (milliseconds)
PAGE_LOAD_TIMEOUT = 60_000
NAVIGATION_TIMEOUT = 30_000
ELEMENT_TIMEOUT = 15_000

# Retry settings
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5
SESSION_TIMEOUT_MINUTES = 15

# Browser settings
HEADLESS = False  # Set True for production; False to watch automation
SLOW_MO = 500  # Milliseconds between actions (helps avoid detection)

# Keyring service name for credential storage
KEYRING_SERVICE = "nctracks-verifier"

# Output columns
OUTPUT_COLUMNS = [
    "Medicaid ID",
    "Name",
    "Status",
    "Coverage Start",
    "Coverage End",
    "Plan Name",
    "Checked At",
    "Notes",
]

# Input columns (expected in patient file)
INPUT_COLUMNS = ["Medicaid ID", "First Name", "Last Name", "DOB"]
