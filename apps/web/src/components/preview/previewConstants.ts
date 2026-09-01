/** Cap for the per-thread "recently seen" URL list shown in the empty state. */
export const PREVIEW_RECENT_URL_LIMIT = 10;

/**
 * Common Chromium error codes mapped to a short human label (i18n message id).
 * Used by the unreachable view to drop the raw `ERR_*` code in favour of
 * friendlier copy.
 */
export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "preview.dnsAddressCouldNotBeFound",
  ERR_NAME_RESOLUTION_FAILED: "preview.dnsAddressCouldNotBeFound",
  ERR_CONNECTION_REFUSED: "preview.connectionRefused",
  ERR_CONNECTION_RESET: "preview.connectionWasReset",
  ERR_CONNECTION_CLOSED: "preview.connectionWasClosed",
  ERR_CONNECTION_TIMED_OUT: "preview.connectionTimedOut",
  ERR_INTERNET_DISCONNECTED: "preview.noInternetConnection",
  ERR_TIMED_OUT: "preview.connectionTimedOut",
  ERR_CERT_AUTHORITY_INVALID: "preview.certificateAuthorityNotTrusted",
  ERR_CERT_COMMON_NAME_INVALID: "preview.certificateHostnameMismatch",
  ERR_CERT_DATE_INVALID: "preview.certificateExpiredOrNotYetValid",
  ERR_TOO_MANY_REDIRECTS: "preview.tooManyRedirects",
});
