import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId } from "@codework/contracts";
import type { AcpRegistryCatalogResult } from "@codework/contracts";
import { t } from "~/i18n";

const mock = vi.hoisted(() => ({
  catalog: {} as AcpRegistryCatalogResult,
  install: vi.fn(async () => ({ _tag: "Success" as const, value: { command: "" } })),
}));
vi.mock("~/i18n", () => ({
  t: (key: string, params?: Record<string, string>) =>
    `${key} ${Object.values(params ?? {}).join(" ")}`,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(mock.catalog) }));
vi.mock("../../state/server", () => ({
  byokEnvironment: {
    acpRegistryCatalog: () => "catalog",
    installAcpRegistryBinary: "install",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mock.install,
}));

import { AcpRegistryCatalogPicker } from "./AcpRegistryCatalogPicker";

it("目录离线警告不会隐藏可选择的快照条目，旧服务端空结果仍明确报错", () => {
  mock.catalog = {
    entries: [
      {
        id: "cline",
        name: "Cline",
        description: "",
        version: "3.0.65",
        command: "npx -y cline@3.0.65 --acp",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/cline.svg",
        availability: "installable",
      },
    ],
    error: "unavailable",
    source: "bundled",
    snapshotDate: "2026-09-30",
  };
  const render = () =>
    renderToStaticMarkup(
      <AcpRegistryCatalogPicker
        environmentId={EnvironmentId.make("test")}
        selectedCommand=""
        onSelect={() => {}}
      />,
    );
  const html = render();
  expect(html).toContain("2026-09-30");
  expect(html).toContain(t("acpRegistryUseAgent", { name: "Cline" }));
  expect(html).toContain("/acp-agent-icons/cline.svg");
  mock.catalog = { entries: [], error: "unavailable" };
  const unavailable = render();
  expect(unavailable).toContain(t("acpRegistryUnavailable"));
  expect(unavailable).not.toContain(t("acpRegistryEmpty"));
});

it("手工入口显示官方安装来源，平台不支持时不提供预填按钮", () => {
  const entry = {
    id: "gjc",
    name: "Gajae Code",
    description: "保留工具权限询问",
    version: null,
    command: "gjc acp",
    availability: "manual" as const,
    setup: {
      documentationUrl: "https://gajae-code.com/docs/",
      installationUrl: "https://gajae-code.com/docs/getting-started.html",
      verifiedAt: "2026-09-30",
    },
  };
  mock.catalog = { entries: [entry], error: null, source: "registry" };
  const render = () =>
    renderToStaticMarkup(
      <AcpRegistryCatalogPicker
        environmentId={EnvironmentId.make("remote")}
        selectedCommand="gjc acp"
        selectedEntryId="gjc"
        onSelect={() => {}}
      />,
    );
  const html = render();
  expect(html).toContain(entry.setup.documentationUrl);
  expect(html).toContain(entry.setup.installationUrl);
  expect(html).toContain(t("acpRegistryManualPreset", { date: "2026-09-30" }));
  expect(html).toContain(t("acpRegistrySelected"));
  mock.catalog = {
    entries: [{ ...entry, command: null, availability: "unsupported-platform" }],
    error: null,
  };
  const unsupported = render();
  expect(unsupported).toContain(t("acpRegistryUnsupported"));
  expect(unsupported).not.toContain(t("acpRegistryUseAgent", { name: entry.name }));
  expect(unsupported).toContain(entry.setup.installationUrl);
});

it("带 sha256 的官方二进制显示下载安装与归档链接", () => {
  mock.catalog = {
    entries: [
      {
        id: "amp-acp",
        name: "Amp",
        description: "",
        version: "0.9.0",
        command: null,
        iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/amp-acp.svg",
        availability: "manual",
        binaryDistribution: {
          platform: "windows-x86_64",
          archiveUrl:
            "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-windows-x86_64.zip",
          sha256: "3b2c3d14d703fcf9572da9733e4941703a7744bd37ec4aaa75421d6002c0157b",
          cmd: "amp-acp.exe",
          args: [],
        },
      },
    ],
    error: null,
    source: "registry",
  };
  const html = renderToStaticMarkup(
    <AcpRegistryCatalogPicker
      environmentId={EnvironmentId.make("local")}
      selectedCommand=""
      onSelect={() => {}}
    />,
  );
  expect(html).toContain("/acp-agent-icons/amp-acp.svg");
  expect(html).toContain(t("acpRegistryDownloadInstallAgent", { name: "Amp" }));
  expect(html).toContain(t("acpRegistryDownloadDetail", { hash: "3b2c3d14d703" }));
  expect(html).toContain(
    "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-windows-x86_64.zip",
  );
  expect(html).not.toContain(t("acpRegistryUseAgent", { name: "Amp" }));
  // Narrow (≈360px) settings panes must be able to wrap the install control
  // under the entry text instead of forcing horizontal overflow.
  expect(html).toContain("flex-wrap");
  expect(html).toMatch(/aria-label="[^"]*Amp[^"]*"/);

  for (const width of [360, 1280] as const) {
    const constrained = renderToStaticMarkup(
      <div style={{ maxWidth: width, width }} data-viewport={width}>
        <AcpRegistryCatalogPicker
          environmentId={EnvironmentId.make("local")}
          selectedCommand=""
          onSelect={() => {}}
        />
      </div>,
    );
    expect(constrained).toContain(`data-viewport="${width}"`);
    expect(constrained).toContain("flex-wrap");
    expect(constrained).toContain(t("acpRegistryDownloadInstallAgent", { name: "Amp" }));
  }
});

it("下载填入命令后，目录行仍显示已选择而不是再次下载", () => {
  mock.catalog = {
    entries: [
      {
        id: "amp-acp",
        name: "Amp",
        description: "",
        version: "0.9.0",
        command: null,
        availability: "manual",
        binaryDistribution: {
          platform: "windows-x86_64",
          archiveUrl:
            "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-windows-x86_64.zip",
          sha256: "3b2c3d14d703fcf9572da9733e4941703a7744bd37ec4aaa75421d6002c0157b",
          cmd: "amp-acp.exe",
          args: [],
        },
      },
    ],
    error: null,
    source: "registry",
  };
  const installed = '"C:\\\\codework\\\\acp-agents\\\\amp-acp\\\\1.0.0\\\\amp-acp.exe"';
  const html = renderToStaticMarkup(
    <AcpRegistryCatalogPicker
      environmentId={EnvironmentId.make("local")}
      selectedCommand={installed}
      selectedEntryId="amp-acp"
      onSelect={() => {}}
    />,
  );
  expect(html).toContain(t("acpRegistrySelected"));
  expect(html).not.toContain(t("acpRegistryDownloadInstallAgent", { name: "Amp" }));
});
