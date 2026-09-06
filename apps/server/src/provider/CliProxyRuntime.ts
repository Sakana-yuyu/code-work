import { CliProxyConfig, ProviderInstanceId } from "@codework/contracts";
import * as Schema from "effect/Schema";

const decodeConfig = Schema.decodeUnknownSync(CliProxyConfig);

/**
 * CLIProxyAPI 的 Code Work 内置运行时状态。
 *
 * 这里故意不创建外部子进程、可执行文件配置或回环 HTTP 客户端：
 * 兼容 API 直接挂在 Code Work 的 HTTP listener 上，账号和路由由本进程管理。
 */
export class CliProxyRuntime {
  config: CliProxyConfig = { strategy: "round-robin" };
  connectedInstanceId: ProviderInstanceId | undefined;
  readonly baseUrl: string;

  constructor(origin: string, connectedInstanceId?: ProviderInstanceId) {
    this.baseUrl = `${origin.replace(/\/+$/u, "")}/v1`;
    this.connectedInstanceId = connectedInstanceId;
  }

  get running(): true {
    return true;
  }

  get version(): "embedded" {
    return "embedded";
  }

  configure(config: CliProxyConfig): void {
    this.config = decodeConfig(config);
  }

  saveConnection(instanceId: ProviderInstanceId): void {
    this.connectedInstanceId = instanceId;
  }
}

/** 只投影展示字段，凭据、原始错误及访问令牌不会传到客户端。 */
export const projectCliProxyAccount = (input: {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly authKind?: string | undefined;
}): {
  readonly name: string;
  readonly provider: string;
  readonly disabled: boolean;
  readonly status: string;
} => ({
  name: input.id,
  provider: input.provider,
  disabled: !input.enabled,
  status: input.enabled ? "ready" : "disabled",
});
