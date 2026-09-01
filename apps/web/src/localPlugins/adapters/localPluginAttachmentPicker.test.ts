import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { pickLocalPluginAttachmentFiles } from "./localPluginAttachmentPicker";

class FakeFileInput extends EventTarget {
  type = "";
  accept = "";
  multiple = false;
  hidden = false;
  files: FileList | null = null;
  click = vi.fn();
  remove = vi.fn();
}

function installDocument(input: FakeFileInput) {
  const appendChild = vi.fn();
  vi.stubGlobal("document", {
    body: { appendChild },
    createElement: vi.fn(() => input),
  });
  return { appendChild };
}

function fileList(files: ReadonlyArray<File>): FileList {
  return {
    ...Object.fromEntries(files.map((file, index) => [index, file])),
    item: (index: number) => files[index] ?? null,
    length: files.length,
  } as unknown as FileList;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("localPluginAttachmentPicker", () => {
  it("用贡献声明配置一次性原生文件选择器并返回所选文件", async () => {
    const input = new FakeFileInput();
    const { appendChild } = installDocument(input);
    const picked = pickLocalPluginAttachmentFiles({
      accept: ["image/png", "image/jpeg"],
      multiple: true,
    });

    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/png,image/jpeg");
    expect(input.multiple).toBe(true);
    expect(input.hidden).toBe(true);
    expect(appendChild).toHaveBeenCalledWith(input);
    expect(input.click).toHaveBeenCalledTimes(1);

    const file = new File(["image"], "diagram.png", { type: "image/png" });
    input.files = fileList([file]);
    input.dispatchEvent(new Event("change"));

    await expect(picked).resolves.toEqual([file]);
    expect(input.remove).toHaveBeenCalledTimes(1);
  });

  it("把原生选择取消映射为 null 并清理临时输入元素", async () => {
    const input = new FakeFileInput();
    installDocument(input);
    const picked = pickLocalPluginAttachmentFiles({
      accept: ["image/webp"],
      multiple: true,
    });

    input.dispatchEvent(new Event("cancel"));

    await expect(picked).resolves.toBeNull();
    expect(input.remove).toHaveBeenCalledTimes(1);
  });

  it("原生选择器无法启动时拒绝调用并清理元素", async () => {
    const input = new FakeFileInput();
    input.click.mockImplementation(() => {
      throw new Error("picker blocked");
    });
    installDocument(input);

    await expect(
      pickLocalPluginAttachmentFiles({
        accept: ["image/png"],
        multiple: true,
      }),
    ).rejects.toThrow("picker blocked");
    expect(input.remove).toHaveBeenCalledTimes(1);
  });
});
