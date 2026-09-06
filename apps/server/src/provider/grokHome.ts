// @effect-diagnostics nodeBuiltinImport:off - 纯路径计算与登录命令共用，不执行文件读写。
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expandHomePath } from "../pathExpansion.ts";

/** 原生默认实例沿用个人目录；新增账号和代理实例使用独立目录，不复制个人凭据。 */
export function resolveGrokHome(input: {
  readonly stateDir: string;
  readonly instanceId: string;
  readonly routed: boolean;
  readonly explicitHome?: string | undefined;
}): string {
  const explicit = input.explicitHome?.trim();
  if (explicit) return NodePath.resolve(expandHomePath(explicit));
  if (!input.routed && input.instanceId === "grok") return NodePath.join(NodeOS.homedir(), ".grok");
  return NodePath.join(
    input.stateDir,
    "provider-homes",
    "grok",
    `instance-${encodeURIComponent(input.instanceId).replace(/\./g, "%2E")}`,
  );
}

export function isDefaultGrokHome(home: string): boolean {
  return NodePath.relative(home, NodePath.join(NodeOS.homedir(), ".grok")) === "";
}
