import type { IExtensionService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensions.service";

/** 上游 whenReady 可能只完成入队，主题列表须等扩展注册事件再读取。 */
export async function registerAndWaitForExtension(
  service: Pick<IExtensionService, "extensions" | "onDidChangeExtensions">,
  id: string,
  register: () => Promise<void>,
): Promise<void> {
  let complete!: () => void;
  const registered = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const listener = service.onDidChangeExtensions(({ added }) => {
    if (added.some((extension) => extension.identifier.value === id)) complete();
  });
  try {
    await register();
    if (!service.extensions.some((extension) => extension.identifier.value === id))
      await registered;
  } finally {
    listener.dispose();
  }
}

export function runInBackground(
  task: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  void task().catch(onError);
}
