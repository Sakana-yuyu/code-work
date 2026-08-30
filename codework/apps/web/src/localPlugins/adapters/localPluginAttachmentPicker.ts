import type { LocalPluginAttachmentPickRequest } from "./localPluginAttachmentAdapter";

export function pickLocalPluginAttachmentFiles(
  request: LocalPluginAttachmentPickRequest,
): Promise<ReadonlyArray<File> | null> {
  if (typeof document === "undefined" || document.body === null) {
    return Promise.reject(new Error("当前没有可用的原生文件选择器。"));
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = request.accept.join(",");
  input.multiple = request.multiple;
  input.hidden = true;
  document.body.appendChild(input);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
    };
    const finish = (files: ReadonlyArray<File> | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(files);
    };
    const onChange = () => finish(Array.from(input.files ?? []));
    const onCancel = () => finish(null);

    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    try {
      input.click();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}
