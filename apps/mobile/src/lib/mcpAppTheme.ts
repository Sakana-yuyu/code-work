import {
  getMobileThemeVariables,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "./mobileTheme";

/**
 * The thread's theme as an MCP App sees it: the spec's standardized style
 * names (`--background`, `--card`, …) resolved from the mobile theme, which
 * `mcpAppStyleVariables` then maps to the app variables. Mobile themes carry
 * no material-you system colors, so roles the theme lacks stay absent.
 */
export function mobileMcpAppTheme(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): {
  readonly appearance: MobileThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
} {
  const theme = getMobileThemeVariables(themeId, appearance);
  const pick = (name: keyof typeof theme) => theme[name];
  const variables: Record<string, string> = {};
  const pairs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--background", pick("--color-screen")],
    ["--foreground", pick("--color-foreground")],
    ["--muted", pick("--color-subtle")],
    ["--muted-foreground", pick("--color-foreground-muted")],
    ["--card", pick("--color-card")],
    ["--card-alt", pick("--color-card-alt")],
    ["--border", pick("--color-border")],
    ["--input", pick("--color-input-border")],
    ["--ring", pick("--color-primary")],
    ["--primary", pick("--color-primary")],
    ["--primary-foreground", pick("--color-primary-foreground")],
    ["--accent", pick("--color-primary")],
    ["--accent-foreground", pick("--color-primary-foreground")],
    ["--destructive", pick("--color-danger-border")],
    ["--destructive-foreground", pick("--color-danger-foreground")],
    ["--destructive-surface", pick("--color-danger")],
  ];
  for (const [name, value] of pairs) {
    if (value !== undefined && value !== "") variables[name] = value;
  }
  return { appearance, variables };
}
