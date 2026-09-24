import { describe, expect, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { getAcpRegistryCatalog, parseAcpRegistryCatalog } from "./AcpRegistryCatalog.ts";

const runCatalog = (fetchImplementation: typeof globalThis.fetch) =>
  getAcpRegistryCatalog.pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessArchitecture, "x64"),
  );

const asFetch = (
  implementation: (input: string | URL) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

describe("ACP registry catalog", () => {
  it("builds a pinned npx command from safe registry fields", () => {
    const entries = parseAcpRegistryCatalog(
      {
        agents: [
          {
            id: "cline",
            name: "Cline",
            version: "3.0.64",
            distribution: { npx: { package: "cline@3.0.64", args: ["--acp"] } },
          },
        ],
      },
      "win32",
      "x64",
    );

    expect(entries).toMatchObject([
      {
        id: "cline",
        command: "cmd.exe /d /s /c npx -y cline@3.0.64 --acp",
        availability: "installable",
      },
    ]);
    expect(
      parseAcpRegistryCatalog(
        {
          agents: [
            { id: "cline", name: "Cline", distribution: { npx: { package: "cline@3.0.64" } } },
          ],
        },
        "linux",
        "x64",
      )[0]?.command,
    ).toBe("npx -y cline@3.0.64");
  });

  it("does not make untrusted package and argument text executable", () => {
    const entries = parseAcpRegistryCatalog(
      {
        agents: [
          { id: "one", name: "One", distribution: { npx: { package: "x@1.0.0; rm", args: [] } } },
          {
            id: "two",
            name: "Two",
            distribution: { npx: { package: "x@1.0.0", args: ["$(bad)"] } },
          },
          {
            id: "three",
            name: "Three",
            distribution: { npx: { package: "x@1.0.0", env: { TOKEN: "secret" } } },
          },
          { id: "four", name: "Four", distribution: { npx: { package: "x@latest" } } },
          { id: "five", name: "Five", distribution: { npx: { package: "--help@1.0.0" } } },
        ],
      },
      "linux",
      "x64",
    );

    expect(
      entries.every((entry) => entry.command === null && entry.availability === "manual"),
    ).toBe(true);
  });

  it("uses the server platform when a registry entry has only a binary distribution", () => {
    const payload = {
      agents: [
        {
          id: "binary",
          name: "Binary",
          distribution: { binary: { "linux-x86_64": { archive: "https://example.com/a.tar.gz" } } },
        },
      ],
    };

    expect(parseAcpRegistryCatalog(payload, "win32", "x64")[0]?.availability).toBe(
      "unsupported-platform",
    );
    expect(parseAcpRegistryCatalog(payload, "linux", "x64")[0]?.availability).toBe("manual");
  });

  it("rejects a malformed registry response", () => {
    expect(() => parseAcpRegistryCatalog({ agents: {} }, "linux", "x64")).toThrow(
      "Invalid ACP registry payload",
    );
  });

  it.effect("reads the official registry URL through the server HTTP client", () =>
    Effect.gen(function* () {
      let requestedUrl = "";
      const result = yield* runCatalog(
        asFetch(async (input) => {
          requestedUrl = String(input);
          return new Response(
            JSON.stringify({
              agents: [
                { id: "cline", name: "Cline", distribution: { npx: { package: "cline@3.0.64" } } },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      expect(requestedUrl).toBe(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
      );
      expect(result.error).toBeNull();
      expect(result.entries[0]?.command).toBe("cmd.exe /d /s /c npx -y cline@3.0.64");
    }),
  );

  it.effect("keeps manual configuration available when the registry is unavailable", () =>
    Effect.gen(function* () {
      const result = yield* runCatalog(
        asFetch(async () => new Response("offline", { status: 503 })),
      );
      expect(result).toEqual({ entries: [], error: "unavailable" });
    }),
  );
});
