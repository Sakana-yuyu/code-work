import type { AcpRegistryCatalogEntry } from "@codework/contracts";

/** 2026-09-30 核对的官方手工安装入口；版本由本机安装决定，来源详见各项 setup。 */
const MANUAL_AGENTS: ReadonlyArray<
  AcpRegistryCatalogEntry & {
    readonly platforms: ReadonlyArray<NodeJS.Platform>;
  }
> = [
  {
    id: "codewhale",
    name: "CodeWhale",
    version: null,
    description:
      "先安装 CodeWhale 并配置模型。ACP 支持基础会话与工具审批；上游尚未提供完整持久线程能力。",
    command: "codewhale serve --acp",
    availability: "manual",
    platforms: ["win32", "darwin", "linux", "freebsd", "openbsd", "android"],
    setup: {
      documentationUrl:
        "https://github.com/Hmbown/CodeWhale/blob/main/docs/RUNTIME_API.md#acp-stdio-adapter-codewhale-serve---acp",
      installationUrl: "https://codewhale.net/en/install",
      verifiedAt: "2026-09-30",
    },
  },
  {
    id: "gjc",
    name: "Gajae Code",
    version: null,
    description:
      "先安装 gjc 并配置模型和凭据，认证方法使用 agent。保留工具权限询问；Windows 官方独立二进制目前仅列出 x64。认证响应成功不代表已选模型或账号可用。",
    command: "gjc acp",
    authMethodId: "agent",
    availability: "manual",
    platforms: ["win32", "darwin", "linux"],
    environment: [{ name: "GJC_ACP_PERMISSION_MODE", value: "prompt", sensitive: false }],
    setup: {
      documentationUrl:
        "https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/terminal-app-integrations.md#paseo",
      installationUrl: "https://gajae-code.com/docs/getting-started.html",
      verifiedAt: "2026-09-30",
    },
  },
  {
    id: "hermes",
    name: "Hermes",
    version: null,
    description:
      "先安装官方 Hermes 与 ACP extra，并用 hermes model 配置模型。Windows 工具执行还需要 Git Bash，可用 HERMES_GIT_BASH_PATH 指定路径。认证方法留空使用已有配置；hermes acp --check 仅检查依赖，不使用同名 PyPI 包安装。",
    command: "hermes acp",
    authMethodId: "",
    availability: "manual",
    platforms: ["win32", "darwin", "linux", "android"],
    setup: {
      documentationUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp",
      installationUrl: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
      verifiedAt: "2026-09-30",
    },
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    version: null,
    description:
      "先安装 Kiro CLI 并登录。官方 Windows 包仅提供 x64，要求 Windows 11；Linux 需满足 glibc 2.34+ 或使用 musl 版本。版本检查通过不代表 ACP 已就绪。",
    command: "kiro-cli acp",
    availability: "manual",
    platforms: ["win32", "darwin", "linux"],
    setup: {
      documentationUrl: "https://kiro.dev/docs/cli/acp/",
      installationUrl: "https://kiro.dev/docs/getting-started/installation/",
      verifiedAt: "2026-09-30",
    },
  },
  {
    id: "traecli",
    name: "TRAE CLI",
    version: null,
    description:
      "先安装 TRAE CLI 并完成企业账号登录。要求 Windows 10+、macOS 14.7.8+，或官方支持的 Linux 发行版。",
    command: "traecli acp serve",
    availability: "manual",
    platforms: ["win32", "darwin", "linux"],
    setup: {
      documentationUrl: "https://docs.trae.cn/cli_acp",
      installationUrl: "https://docs.trae.cn/cli_get-started-with-trae-cli",
      verifiedAt: "2026-09-30",
    },
  },
];

/** 只补精确 ID 缺项；在线条目优先，绝不以旧手工配置覆盖上游新分发。 */
export function withManualAcpCatalog(
  entries: ReadonlyArray<AcpRegistryCatalogEntry>,
  platform: NodeJS.Platform,
  arch: string,
): AcpRegistryCatalogEntry[] {
  const existing = new Set(entries.map((entry) => entry.id));
  const manual = MANUAL_AGENTS.filter((entry) => !existing.has(entry.id)).map(
    ({ platforms, ...entry }) => {
      const supported =
        platforms.includes(platform) &&
        (arch === "x64" || arch === "arm64") &&
        !(platform === "android" && arch !== "arm64") &&
        !(["gjc", "kiro"].includes(entry.id) && platform === "win32" && arch !== "x64");
      return supported
        ? entry
        : { ...entry, command: null, availability: "unsupported-platform" as const };
    },
  );
  return [...entries, ...manual].sort((a, b) => a.name.localeCompare(b.name));
}
