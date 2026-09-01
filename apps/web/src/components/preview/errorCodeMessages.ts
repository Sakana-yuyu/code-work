import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";
import { t } from "~/i18n";

/**
 * Resolve a friendly description for a Chromium / network error. Falls back
 * to the description string passed in when it isn't in our table.
 */
export function describePreviewError(description: string): string {
  const messageId = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (messageId) return t(messageId);
  if (description.length > 0) return description;
  return t("preview.networkError");
}
