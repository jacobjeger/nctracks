"""Configuration constants for NCTracks Eligibility Verifier."""

# ─── NCTracks URLs ───
NCTRACKS_HOME = "https://www.nctracks.nc.gov"
PROVIDER_PORTAL_LOGIN = "https://www.nctracks.nc.gov/ncmmisPortal/loginAction?flow=PP"
NCID_LOGIN_BASE = "https://login.myncid.nc.gov"
ELIGIBILITY_INQUIRY_URL = "https://www.nctracks.nc.gov/DirectConnect/Eligibility/Inquiry"

# ─── Passage Health EMR ───
PASSAGEHEALTH_LOGIN_URL = "https://clinical.passagehealth.com"
PASSAGEHEALTH_FUNDING_SOURCES_URL = (
    "https://clinical.passagehealth.com/dashboard/reporting/clients/funding-sources"
)
PASSAGEHEALTH_FUNDING_SOURCES = [
    "Alliance Behavioral Health NC",
    "Amerihealth Caritas North Carolina",
    "Healthy Blue North Carolina",
    "Partners in Behavioral Health NC",
    "Trillium Health Resources NC",
    "Vaya Health",
    "United Healthcare Community Plan of NC",
    "WellCare of North Carolina",
]
# Maps EMR payer names → NCTracks Managing Entity patterns (partial, case-insensitive)
PAYER_MAPPING = {
    "Alliance Behavioral Health NC": "ALLIANCE HEALTH",
    "Amerihealth Caritas North Carolina": "AMERIHEALTH CARITAS",
    "Healthy Blue North Carolina": "HEALTHY BLUE",
    "Partners in Behavioral Health NC": "PARTNERS BEHAVIORAL HEALTH",
    "Trillium Health Resources NC": "TRILLIUM HEALTH",
    "Vaya Health": "VAYA HEALTH",
    "United Healthcare Community Plan of NC": "UNITEDHEALTHCARE",
    "WellCare of North Carolina": "WELLCARE",
}
# Statuses that mean insurance is inactive (skip these rows during EMR scrape)
INACTIVE_STATUSES = [
    "inactive", "terminated", "cancelled", "canceled", "expired", "closed",
]

# ─── Provider defaults for Verify Recipient form ───
DEFAULT_GROUP = "144862:1396570"
DEFAULT_NPI = "1396570701"
DOS_RANGE_DAYS = 35

# ─── Timeouts (milliseconds for Playwright) ───
PAGE_LOAD_TIMEOUT = 60_000
NAVIGATION_TIMEOUT = 30_000
ELEMENT_TIMEOUT = 15_000

# ─── Timeouts (seconds) ───
MFA_TIMEOUT_SECONDS = 300  # 5 minutes
EMR_PAGE_LOAD_DELAY = 3
EMR_FILTER_DELAY = 2

# ─── Retry settings ───
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5
SESSION_TIMEOUT_MINUTES = 15

# ─── Browser settings ───
HEADLESS = True  # Start headless; browser shown visible only for MFA
SLOW_MO = 100

# ─── Credential storage ───
KEYRING_SERVICE = "nctracks-verifier"

# ─── Name validation noise ───
NAME_LABEL_NOISE = [
    "last name:", "first name:", "date of birth:", "name:", "dob:",
    "recipient name:", "recipient id:", "gender:", "admin county code:",
    "primary care provider:", "daytime phone:", "address:",
    "tailored care manager:", "tribal member:",
]

# ─── Phrases / selectors for detection ───
NOT_FOUND_PHRASES = [
    "NO RECORDS FOUND", "NO RESULTS", "RECIPIENT NOT FOUND",
    "NOT FOUND", "NO MATCHING", "INVALID",
]
SESSION_TIMEOUT_PHRASES = [
    "SESSION HAS EXPIRED", "SESSION TIMEOUT", "SESSION TIMED OUT",
    "PLEASE LOG IN AGAIN", "LOGIN REQUIRED",
]
MFA_PAGE_PHRASES = [
    "VERIFICATION CODE", "MULTI-FACTOR", "MFA", "ONE-TIME",
    "AUTHENTICAT", "SECURITY CODE", "VERIFY YOUR IDENTITY",
    "PUSH NOTIFICATION", "DUO", "APPROVE THE REQUEST",
    "SEND ME A PUSH", "TWO-FACTOR", "TWO FACTOR", "2FA",
    "SECOND FACTOR", "ADDITIONAL VERIFICATION",
]

# ─── Output columns ───
OUTPUT_COLUMNS = [
    "Medicaid ID", "Name", "Status",
    "EMR Funding Source", "Insurance Type",
    "Managing Entity (Current)", "Current Period", "Payer Changed?",
    "Managing Entity (Next)", "Next Period", "Payer Changed (Next)?",
    "Checked At", "Notes",
]

# Input columns (expected in patient file)
INPUT_COLUMNS = ["Medicaid ID", "First Name", "Last Name", "DOB"]
