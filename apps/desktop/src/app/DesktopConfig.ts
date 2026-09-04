import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const preferredString = (canonicalName: string, legacyName: string) =>
  Config.all({
    canonical: trimmedString(canonicalName),
    legacy: trimmedString(legacyName),
  }).pipe(Config.map(({ canonical, legacy }) => Option.orElse(canonical, () => legacy)));

const preferredBoolean = (canonicalName: string, legacyName: string) =>
  Config.all({
    canonical: Config.boolean(canonicalName).pipe(Config.option),
    legacy: Config.boolean(legacyName).pipe(Config.option),
  }).pipe(
    Config.map(({ canonical, legacy }) =>
      Option.getOrElse(
        Option.orElse(canonical, () => legacy),
        () => false,
      ),
    ),
  );

const preferredPort = (canonicalName: string, legacyName: string) =>
  Config.all({
    canonical: Config.port(canonicalName).pipe(Config.option),
    legacy: Config.port(legacyName).pipe(Config.option),
  }).pipe(Config.map(({ canonical, legacy }) => Option.orElse(canonical, () => legacy)));

const preferredInteger = (canonicalName: string, legacyName: string, defaultValue: number) =>
  Config.all({
    canonical: Config.int(canonicalName).pipe(Config.option),
    legacy: Config.int(legacyName).pipe(Config.option),
  }).pipe(
    Config.map(({ canonical, legacy }) =>
      Option.getOrElse(
        Option.orElse(canonical, () => legacy),
        () => defaultValue,
      ),
    ),
  );

const preferredUrl = (canonicalName: string, legacyName: string) =>
  Config.all({
    canonical: Config.url(canonicalName).pipe(Config.option),
    legacy: Config.url(legacyName).pipe(Config.option),
  }).pipe(Config.map(({ canonical, legacy }) => Option.orElse(canonical, () => legacy)));

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  codeworkHome: preferredString("CODEWORK_HOME", "CODEWORK_HOME"),
  devServerUrl: preferredUrl("CODEWORK_DEV_SERVER_URL", "VITE_DEV_SERVER_URL"),
  appUserModelIdOverride: preferredString(
    "CODEWORK_DESKTOP_APP_USER_MODEL_ID",
    "CODEWORK_DESKTOP_APP_USER_MODEL_ID",
  ),
  devRemoteCodeworkServerEntryPath: preferredString(
    "CODEWORK_DEV_REMOTE_SERVER_ENTRY_PATH",
    "CODEWORK_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
  ),
  configuredBackendPort: preferredPort("CODEWORK_PORT", "CODEWORK_PORT"),
  commitHashOverride: preferredString("CODEWORK_COMMIT_HASH", "CODEWORK_COMMIT_HASH"),
  desktopLanHostOverride: preferredString("CODEWORK_DESKTOP_LAN_HOST", "CODEWORK_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("CODEWORK_DESKTOP_HTTPS_ENDPOINTS").pipe(
    Config.orElse(() => commaSeparatedStrings("CODEWORK_DESKTOP_HTTPS_ENDPOINTS")),
  ),
  otlpTracesUrl: preferredString("CODEWORK_OTLP_TRACES_URL", "CODEWORK_OTLP_TRACES_URL"),
  otlpExportIntervalMs: preferredInteger(
    "CODEWORK_OTLP_EXPORT_INTERVAL_MS",
    "CODEWORK_OTLP_EXPORT_INTERVAL_MS",
    10_000,
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: preferredBoolean(
    "CODEWORK_DISABLE_AUTO_UPDATE",
    "CODEWORK_DISABLE_AUTO_UPDATE",
  ),
  mockUpdates: preferredBoolean("CODEWORK_DESKTOP_MOCK_UPDATES", "CODEWORK_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: preferredPort(
    "CODEWORK_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    "CODEWORK_DESKTOP_MOCK_UPDATE_SERVER_PORT",
  ).pipe(Config.map(Option.getOrElse(() => 3000))),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
