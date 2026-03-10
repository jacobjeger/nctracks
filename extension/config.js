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

  // MFA / OTP input selectors (PingFederate NCID MFA page)
  MFA_INPUT_SELECTORS: [
    'input[name="otp"]',
    'input[name="pf.challengeResponse"]',
    'input[name*="otp" i]',
    'input[name*="code" i]',
    'input[name*="verification" i]',
    'input[name*="token" i]',
    'input[id*="otp" i]',
    'input[id*="code" i]',
    'input[type="tel"]',
    'input[type="number"][maxlength="6"]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
  ],
  MFA_SUBMIT_SELECTORS: [
    'a.ping-button',  // filter by text "Verify/Submit" in code
    'button',         // filter by text "Verify/Submit" in code
    'input[type="submit"]',
    'button[type="submit"]',
  ],

  // Eligibility form selectors — based on actual NCTracks "Verify Recipient" page
  // The page uses table-based layout with labels in preceding <td> cells.
  // Element IDs may be dynamic (JSF-style), so we use multiple fallback strategies.
  // Flow: Account Information → Group → NPI / Atypical ID (cascading dropdowns)
  ACCOUNT_SELECTORS: [
    'select[name*="account" i]',
    'select[id*="account" i]',
    'select[name*="Account"]',
    'select[id*="Account"]',
  ],
  GROUP_SELECTORS: [
    'select[name*="group" i]',
    'select[id*="group" i]',
    'select[name*="Group"]',
    'select[id*="Group"]',
  ],
  NPI_SELECTORS: [
    'select[name*="npi" i]',
    'select[id*="npi" i]',
    'select[name*="Npi"]',
    'select[name*="atypical" i]',
    'select[id*="atypical" i]',
    'select[name*="Atypical"]',
    'select[id*="Atypical"]',
  ],
  RECIPIENT_ID_SELECTORS: [
    'input[name*="recipientId" i]',
    'input[id*="recipientId" i]',
    'input[name*="RecipientId"]',
    'input[id*="RecipientId"]',
    'input[name*="Recipient" i]',
    'input[id*="Recipient" i]',
  ],
  DOS_FROM_SELECTORS: [
    'input[id="DateOfServiceStart"]',
    'input[id*="DateOfServiceStart"]',
    'input[id*="dateOfServiceStart" i]',
    'input[name*="DateOfServiceStart"]',
    'input[name*="dateOfServiceFrom" i]',
    'input[id*="dateOfServiceFrom" i]',
    'input[name*="dosFrom" i]',
    'input[name*="serviceFrom" i]',
    'input[name*="ServiceStart" i]',
  ],
  DOS_TO_SELECTORS: [
    'input[id="txtDateOfServiceEnd"]',
    'input[id*="txtDateOfServiceEnd"]',
    'input[id="DateOfServiceEnd"]',
    'input[id*="DateOfServiceEnd"]',
    'input[id*="dateOfServiceEnd" i]',
    'input[name*="DateOfServiceEnd"]',
    'input[name*="dateOfServiceTo" i]',
    'input[id*="dateOfServiceTo" i]',
    'input[name*="dosTo" i]',
    'input[name*="serviceTo" i]',
    'input[name*="ServiceEnd" i]',
  ],
  CHECK_ELIGIBILITY_SELECTORS: [
    'input[value="Check Eligibility"]',
    'input[value*="Check Elig"]',
    'a[title*="Check Eligibility"]',
    'a[href*="checkEligibility"]',
    'input[type="submit"][value*="Eligib"]',
    'input[type="button"][value*="Eligib"]',
  ],
  CLEAR_SELECTORS: [
    'input[value="Clear"]',
    'a[title="Clear"]',
    'a[href*="clear"]',
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

  // Passage Health EMR
  PASSAGEHEALTH_LOGIN_URL: "https://clinical.passagehealth.com",
  PASSAGEHEALTH_REPORTS_URL: "https://clinical.passagehealth.com/dashboard/reporting/clients",
  PASSAGEHEALTH_FUNDING_SOURCES: [
    "Alliance Behavioral Health NC",
    "Amerihealth Caritas North Carolina",
    "Healthy Blue North Carolina",
    "Partners in Behavioral Health NC",
    "Trillium Health Resources NC",
    "Vaya Health",
    "United Healthcare Community Plan of NC",
    "WellCare of North Carolina",
  ],
  // Maps EMR funding source names → NCTracks Managing Entity patterns (partial match, case-insensitive)
  PAYER_MAPPING: {
    "Alliance Behavioral Health NC": "ALLIANCE HEALTH",
    "Amerihealth Caritas North Carolina": "AMERIHEALTH CARITAS",
    "Healthy Blue North Carolina": "HEALTHY BLUE",
    "Partners in Behavioral Health NC": "PARTNERS BEHAVIORAL HEALTH",
    "Trillium Health Resources NC": "TRILLIUM HEALTH",
    "Vaya Health": "VAYA HEALTH",
    "United Healthcare Community Plan of NC": "UNITEDHEALTHCARE",
    "WellCare of North Carolina": "WELLCARE",
  },

  // Output columns
  OUTPUT_COLUMNS: [
    "Medicaid ID", "Name", "Status", "DOB", "Gender", "County",
    "Benefit Plan", "Category of Eligibility", "Dates of Enrollment",
    "Managing Entity", "Managed Care", "PCP Name", "PCP Phone",
    "Tailored Care Manager", "TCM Phone", "Other Insurance",
    "Medicare Part A", "Medicare Part B", "Hospice", "Checked At", "Notes",
  ],
};

// Make available in both content script and module contexts
if (typeof globalThis !== "undefined") {
  globalThis.NCTRACKS_CONFIG = NCTRACKS_CONFIG;
}
