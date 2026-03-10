/* Shared configuration for NCTracks Eligibility Verifier extension. */

const NCTRACKS_CONFIG = {
  // URLs
  PROVIDER_PORTAL_LOGIN: "https://www.nctracks.nc.gov/ncmmisPortal/loginAction?flow=PP",
  NCID_LOGIN_BASE: "https://login.myncid.nc.gov",
  ELIGIBILITY_INQUIRY_URL: "https://www.nctracks.nc.gov/DirectConnect/Eligibility/Inquiry",

  // Provider defaults
  DEFAULT_GROUP: "144862:1396570",
  DEFAULT_NPI: "1396570701",
  DOS_RANGE_DAYS: 35,

  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 5000,
  INTER_PATIENT_DELAY_MS: 1000,
  MFA_TIMEOUT_MS: 300000, // 5 minutes
  CAPTCHA_TIMEOUT_MS: 300000,

  // Login selectors
  USERNAME_SELECTORS: [
    'input[name="pf.username"]',
    'input[id="username"]',
    'input[name="username"]',
    'input[type="text"][name*="user"]',
    'input[type="text"]',
  ],
  NEXT_BUTTON_SELECTORS: [
    'a.ping-button',  // filter by text "Next" in code
    'button',         // filter by text "Next" in code
    'a',              // filter by text "Next" in code
    'input[type="submit"]',
    'button[type="submit"]',
    '.btn-primary',
  ],
  PASSWORD_SELECTORS: [
    'input[name="pf.pass"]',
    'input[id="password"]',
    'input[name="password"]',
    'input[type="password"]',
  ],
  SIGN_ON_SELECTORS: [
    'a.ping-button',  // filter by text "Sign On" in code
    'button',         // filter by text "Sign On/In" in code
    'input[type="submit"]',
    'button[type="submit"]',
  ],

  // Eligibility form selectors
  GROUP_SELECTORS: [
    'select[name*="group" i]',
    'select[id*="group" i]',
    'select[name*="Group"]',
  ],
  NPI_SELECTORS: [
    'select[name*="npi" i]',
    'select[id*="npi" i]',
    'select[name*="Npi"]',
    'select[name*="atypical" i]',
    'select[id*="atypical" i]',
  ],
  RECIPIENT_ID_SELECTORS: [
    'input[name*="recipientId" i]',
    'input[id*="recipientId" i]',
    'input[name*="RecipientId"]',
    'input[id*="RecipientId"]',
  ],
  DOS_FROM_SELECTORS: [
    'input[name*="dateOfServiceFrom" i]',
    'input[id*="dateOfServiceFrom" i]',
    'input[name*="dosFrom" i]',
    'input[name*="serviceFrom" i]',
  ],
  DOS_TO_SELECTORS: [
    'input[name*="dateOfServiceTo" i]',
    'input[id*="dateOfServiceTo" i]',
    'input[name*="dosTo" i]',
    'input[name*="serviceTo" i]',
  ],
  CHECK_ELIGIBILITY_SELECTORS: [
    'input[value="Check Eligibility"]',
    'input[value*="Check Elig"]',
    'input[type="submit"][value*="Eligib"]',
    'input[type="submit"]',
    'button[type="submit"]',
  ],
  CLEAR_SELECTORS: [
    'input[value="Clear"]',
  ],

  // Result scraping
  NOT_FOUND_PHRASES: [
    "NO RECORDS FOUND",
    "NO RESULTS",
    "RECIPIENT NOT FOUND",
    "NOT FOUND",
    "NO MATCHING",
    "INVALID",
  ],
  SESSION_TIMEOUT_PHRASES: [
    "SESSION HAS EXPIRED",
    "SESSION TIMEOUT",
    "SESSION TIMED OUT",
    "PLEASE LOG IN AGAIN",
    "LOGIN REQUIRED",
  ],
  CAPTCHA_SELECTORS: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    'div.g-recaptcha',
    'div[id*="captcha"]',
    '#captcha',
  ],
  COVERAGE_SELECTORS: {
    coverage_start: ['td:has(~ td)', 'span[id*="startDate"]'],
    coverage_end: ['td:has(~ td)', 'span[id*="endDate"]'],
    plan_name: ['td:has(~ td)', 'span[id*="planName"]'],
  },

  // Output columns
  OUTPUT_COLUMNS: [
    "Medicaid ID", "Name", "Status", "Coverage Start",
    "Coverage End", "Plan Name", "Checked At", "Notes",
  ],
};

// Make available in both content script and module contexts
if (typeof globalThis !== "undefined") {
  globalThis.NCTRACKS_CONFIG = NCTRACKS_CONFIG;
}
