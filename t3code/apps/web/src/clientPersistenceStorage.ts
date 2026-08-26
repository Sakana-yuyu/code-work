import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  LocalStorageOperationError,
  getLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";
import { canonicalStorageKey, readAndMigrateStorageValue } from "./persistenceStorage";

export const LEGACY_CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
export const CLIENT_SETTINGS_STORAGE_KEY = canonicalStorageKey(LEGACY_CLIENT_SETTINGS_STORAGE_KEY);

const decodeClientSettings = (raw: string): ClientSettings =>
  Schema.decodeSync(Schema.fromJsonString(ClientSettingsSchema))(raw);
const encodeClientSettings = (settings: ClientSettings): string =>
  Schema.encodeSync(Schema.fromJsonString(ClientSettingsSchema))(settings);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const migrated = readAndMigrateStorageValue({
      storage: window.localStorage,
      canonicalKey: CLIENT_SETTINGS_STORAGE_KEY,
      legacyKey: LEGACY_CLIENT_SETTINGS_STORAGE_KEY,
      decode: decodeClientSettings,
      encode: encodeClientSettings,
    });
    if (migrated.value !== null) {
      return migrated.value;
    }
    const canonicalRaw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    const legacyRaw = window.localStorage.getItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY);
    const invalidRaw = canonicalRaw ?? legacyRaw;
    if (invalidRaw !== null) {
      try {
        return decodeClientSettings(invalidRaw);
      } catch (cause) {
        throw new LocalStorageOperationError({
          operation: "decode",
          storageKey:
            invalidRaw === canonicalRaw
              ? CLIENT_SETTINGS_STORAGE_KEY
              : LEGACY_CLIENT_SETTINGS_STORAGE_KEY,
          cause,
        });
      }
    }
    return null;
  } catch (error) {
    console.error("Could not read persisted client settings.", error);
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
