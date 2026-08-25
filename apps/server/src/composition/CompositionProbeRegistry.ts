import type {
  CompositionIdeProfile,
  CompositionIdeResolveResult,
  CompositionMulticaProbeResult,
  CompositionRuntimeDriverKind,
  CompositionRuntimeProbeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CompositionProbeFailure extends Schema.TaggedErrorClass<CompositionProbeFailure>()(
  "CompositionProbeFailure",
  {
    adapter: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `组合能力探测失败（${this.adapter}）：${this.detail}`;
  }
}

type RuntimeProbe = {
  readonly runtimeId: string;
  readonly driverKind: CompositionRuntimeDriverKind;
  readonly probe: () => Effect.Effect<CompositionRuntimeProbeResult, CompositionProbeFailure>;
};

type IdeProbe = {
  readonly sessionId: string;
  readonly probe: () => Effect.Effect<CompositionIdeResolveResult, CompositionProbeFailure>;
};

type MulticaProbe = {
  readonly runtimeId: string;
  readonly probe: () => Effect.Effect<CompositionMulticaProbeResult, CompositionProbeFailure>;
};

export interface CompositionProbeRegistryOptions {
  readonly runtimes?: ReadonlyArray<RuntimeProbe>;
  readonly ides?: ReadonlyArray<IdeProbe>;
  readonly multica?: ReadonlyArray<MulticaProbe>;
}

export interface CompositionProbeRegistry {
  readonly probeRuntime: (input: {
    readonly runtimeId: string;
    readonly driverKind: CompositionRuntimeDriverKind;
  }) => Effect.Effect<CompositionRuntimeProbeResult>;
  readonly resolveIde: (input: {
    readonly sessionId: string;
    readonly requestedProfile: string;
  }) => Effect.Effect<CompositionIdeResolveResult>;
  readonly probeMultica: (input: {
    readonly runtimeId: string;
  }) => Effect.Effect<CompositionMulticaProbeResult>;
}

const offlineRuntime = (
  runtimeId: string,
  driverKind: CompositionRuntimeDriverKind,
  reasonCode: string,
): CompositionRuntimeProbeResult => ({
  runtimeId,
  driverKind,
  status: "offline",
  capabilities: [],
  supportsResume: false,
  supportsMcp: false,
  reasonCode,
});

const unavailableIde = (sessionId: string, reasonCode: string): CompositionIdeResolveResult => ({
  sessionId,
  profile: "unknown",
  verifiedOperations: [],
  status: "unavailable",
  reasonCode,
});

const offlineMultica = (runtimeId: string, reasonCode: string): CompositionMulticaProbeResult => ({
  runtimeId,
  status: "offline",
  capabilities: [],
  supportsSquad: false,
  supportsLeader: false,
  supportsTaskGraph: false,
  reasonCode,
});

const isKnownIdeProfile = (profile: string): profile is CompositionIdeProfile =>
  profile === "cursor_ide" ||
  profile === "vscode_ide" ||
  profile === "browser_mcp" ||
  profile === "unknown";

export const makeCompositionProbeRegistry = (
  options: CompositionProbeRegistryOptions = {},
): CompositionProbeRegistry => {
  const runtimes = options.runtimes ?? [];
  const ides = options.ides ?? [];
  const multica = options.multica ?? [];

  const probeRuntime: CompositionProbeRegistry["probeRuntime"] = (input) => {
    const entry = runtimes.find(
      (candidate) =>
        candidate.runtimeId === input.runtimeId && candidate.driverKind === input.driverKind,
    );
    if (entry === undefined) {
      return Effect.succeed(
        offlineRuntime(input.runtimeId, input.driverKind, "runtime_not_registered"),
      );
    }
    return entry
      .probe()
      .pipe(
        Effect.catchTag("CompositionProbeFailure", () =>
          Effect.succeed(offlineRuntime(input.runtimeId, input.driverKind, "runtime_probe_failed")),
        ),
      );
  };

  const resolveIde: CompositionProbeRegistry["resolveIde"] = (input) => {
    const entry = ides.find((candidate) => candidate.sessionId === input.sessionId);
    if (entry === undefined || !isKnownIdeProfile(input.requestedProfile)) {
      return Effect.succeed(unavailableIde(input.sessionId, "ide_profile_unknown"));
    }
    return entry.probe().pipe(
      Effect.map((result) =>
        result.profile === input.requestedProfile && result.profile !== "unknown"
          ? result
          : unavailableIde(
              input.sessionId,
              result.profile === "unknown" ? "ide_profile_unknown" : "ide_profile_mismatch",
            ),
      ),
      Effect.catchTag("CompositionProbeFailure", () =>
        Effect.succeed(unavailableIde(input.sessionId, "ide_probe_failed")),
      ),
    );
  };

  const probeMultica: CompositionProbeRegistry["probeMultica"] = (input) => {
    const entry = multica.find((candidate) => candidate.runtimeId === input.runtimeId);
    if (entry === undefined) {
      return Effect.succeed(offlineMultica(input.runtimeId, "runtime_not_registered"));
    }
    return entry
      .probe()
      .pipe(
        Effect.catchTag("CompositionProbeFailure", () =>
          Effect.succeed(offlineMultica(input.runtimeId, "runtime_probe_failed")),
        ),
      );
  };

  return { probeRuntime, resolveIde, probeMultica };
};
