/**
 * Explicit English catalog. The generated message catalog is the source of
 * truth for English; keeping this named export separate preserves the locale
 * boundary used by the runtime while avoiding source-string fallback.
 */
import { en as generatedEnglishCatalog } from "./messages";

export const en: Record<string, string> = generatedEnglishCatalog;
