import type { EnvironmentMachineKind } from "@codework/contracts";
import type { ColorValue } from "react-native";

import { t } from "../i18n";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export const ENVIRONMENT_MACHINE_SYMBOLS = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
} as const satisfies Record<EnvironmentMachineKind, AppSymbolName>;

export function environmentMachineKindLabel(kind: EnvironmentMachineKind): string {
  return t(`environmentMachineIcon.kind.${kind}`);
}

/** The glyph an environment wears in lists; SF Symbols on iOS, Tabler on Android. */
export function EnvironmentMachineSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColor: ColorValue;
}) {
  return (
    <SymbolView
      accessibilityLabel={environmentMachineKindLabel(props.kind)}
      name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
      size={props.size}
      tintColor={props.tintColor}
      type="monochrome"
    />
  );
}
