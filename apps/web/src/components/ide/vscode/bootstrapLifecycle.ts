const DESKTOP_RESOURCE_SCHEMES = new Set([
  "codework",
  "codework-dev",
  "codework-preview",
  "t3code",
  "t3code-dev",
  "t3code-preview",
]);

export function desktopResourceScheme(protocol: string): string | undefined {
  if (!protocol.endsWith(":")) return undefined;
  const scheme = protocol.slice(0, -1);
  return DESKTOP_RESOURCE_SCHEMES.has(scheme) ? scheme : undefined;
}

export function runInBackground(
  task: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  void task().catch(onError);
}
