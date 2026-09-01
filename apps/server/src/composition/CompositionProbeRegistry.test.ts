import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionProbeRegistry } from "./CompositionProbeRegistry.ts";

describe("CompositionProbeRegistry", () => {
  it("returns injected runtime probes and explicit offline results for unknown runtimes", async () => {
    const registry = makeCompositionProbeRegistry({
      runtimes: [
        {
          runtimeId: "codex-local",
          driverKind: "cli",
          probe: () =>
            Effect.succeed({
              runtimeId: "codex-local",
              driverKind: "cli" as const,
              status: "online" as const,
              capabilities: ["task.cancel"],
              supportsResume: true,
              supportsMcp: true,
            }),
        },
      ],
    });

    await expect(
      Effect.runPromise(registry.probeRuntime({ runtimeId: "codex-local", driverKind: "cli" })),
    ).resolves.toMatchObject({ status: "online", capabilities: ["task.cancel"] });
    await expect(
      Effect.runPromise(registry.probeRuntime({ runtimeId: "missing", driverKind: "cli" })),
    ).resolves.toMatchObject({ status: "offline", reasonCode: "runtime_not_registered" });
  });

  it("does not guess an IDE profile when no adapter is connected", async () => {
    const registry = makeCompositionProbeRegistry({
      ides: [
        {
          sessionId: "vscode-1",
          probe: () =>
            Effect.succeed({
              sessionId: "vscode-1",
              profile: "vscode_ide" as const,
              verifiedOperations: ["workspace.open"],
              status: "ready" as const,
            }),
        },
      ],
    });

    await expect(
      Effect.runPromise(
        registry.resolveIde({ sessionId: "missing", requestedProfile: "cursor_ide" }),
      ),
    ).resolves.toMatchObject({ profile: "unknown", status: "unavailable" });
    await expect(
      Effect.runPromise(
        registry.resolveIde({ sessionId: "vscode-1", requestedProfile: "vscode_ide" }),
      ),
    ).resolves.toMatchObject({ profile: "vscode_ide", status: "ready" });
  });

  it("keeps Multica daemon availability separate from Code Work orchestration", async () => {
    const registry = makeCompositionProbeRegistry({ multica: [] });

    await expect(
      Effect.runPromise(registry.probeMultica({ runtimeId: "multica-local" })),
    ).resolves.toMatchObject({ status: "offline", reasonCode: "runtime_not_registered" });
  });
});
