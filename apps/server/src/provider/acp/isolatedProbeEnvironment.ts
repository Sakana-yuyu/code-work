/** 启动层会合并宿主环境；探针须显式清空非系统项并覆盖用户配置目录。 */
export function isolatedProbeEnvironment(
  home: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const systemKeys = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
  ]);
  return {
    ...Object.fromEntries(Object.entries(environment).map(([key, value]) => [
      key, systemKeys.has(key.toUpperCase()) ? value : "",
    ])),
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
  };
}
