import * as NodeFS from "node:fs";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";

export function isProbeExecutableAvailable(command: string | undefined, env = process.env) {
  if (!command?.trim()) return false;
  return (
    SpawnExecutableResolution.defaultValue()(command, HostProcessPlatform.defaultValue(), env) !==
    undefined
  );
}

export function isProbeScriptAvailable(scriptPath: string | undefined) {
  if (!scriptPath?.trim() || !isProbeExecutableAvailable(process.execPath)) return false;
  try {
    NodeFS.accessSync(scriptPath, NodeFS.constants.R_OK);
    return NodeFS.statSync(scriptPath).isFile();
  } catch {
    return false;
  }
}
