import { useMemo, useSyncExternalStore } from "react";

import {
  appearanceFontStack,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
} from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  themeColorToHex,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

export interface McpAppHostTheme {
  readonly appearance: ThemeAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

// Roles themes cannot change (index.css keeps info/success fixed), plus a
// categorical chart series after the theme's own accent.
const FIXED_COLORS = {
  light: {
    success: "#10b981",
    successForeground: "#047857",
    info: "#3b82f6",
    infoForeground: "#1d4ed8",
    chart: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  },
  dark: {
    success: "#10b981",
    successForeground: "#34d399",
    info: "#3b82f6",
    infoForeground: "#60a5fa",
    chart: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
  },
} as const;

/** Maps a theme palette to the CSS variables an MCP App document styles against. */
function mcpAppThemeVariables(
  colors: ThemeColors,
  appearance: ThemeAppearance,
  fonts: { sans: string; mono: string },
): Record<string, string> {
  const fixed = FIXED_COLORS[appearance];
  return {
    "--background": colors.canvas,
    "--foreground": colors.text,
    "--muted": colors.muted,
    "--muted-foreground": colors.mutedForeground,
    "--card": colors.surface,
    "--card-foreground": colors.text,
    "--popover": colors.surfaceOverlay,
    "--popover-foreground": colors.text,
    "--secondary": colors.secondary,
    "--secondary-foreground": colors.secondaryForeground,
    "--border": colors.border,
    "--input": colors.input,
    "--ring": colors.focus,
    "--primary": colors.messageAction,
    "--primary-foreground": colors.messageActionForeground,
    "--accent": colors.accent,
    "--accent-foreground": colors.accentForeground,
    "--accent-surface": colors.accentSurface,
    "--accent-surface-foreground": colors.accentSurfaceForeground,
    "--destructive": colors.error,
    "--destructive-foreground": colors.errorForeground,
    "--destructive-surface": colors.errorSurface,
    "--warning": colors.warning,
    "--warning-foreground": colors.warningForeground,
    "--warning-surface": colors.warningSurface,
    "--success": fixed.success,
    "--success-foreground": fixed.successForeground,
    "--info": fixed.info,
    "--info-foreground": fixed.infoForeground,
    "--code-background": colors.codeBackground,
    "--code-foreground": colors.codeForeground,
    "--chart-1": colors.accent,
    ...Object.fromEntries(fixed.chart.map((color, index) => [`--chart-${index + 2}`, color])),
    "--radius": "0.625rem",
    "--font-sans": fonts.sans,
    "--font-mono": fonts.mono,
  };
}

/** The palette `applyTheme` paints for a preference, or the stock look when no theme applies. */
function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

/** The app's active theme and fonts, as handed to a hosted MCP App. Stable until one changes. */
export function useMcpAppTheme(): McpAppHostTheme {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(theme, themeHalves, resolvedTheme),
    () => getStandardThemeColors(resolvedTheme),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  return useMemo(
    () => ({
      appearance: resolvedTheme,
      variables: mcpAppThemeVariables(
        Object.fromEntries(
          Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
        ) as ThemeColors,
        resolvedTheme,
        {
          sans: appearanceFontStack(sans, DEFAULT_SANS_FONT_STACK),
          mono: appearanceFontStack(mono, DEFAULT_CODE_FONT_STACK),
        },
      ),
    }),
    [colors, resolvedTheme, sans, mono],
  );
}
