import { describe, expect, it } from "vite-plus/test";
import { codeossFilePath } from "./codeossCommands";

describe("原生 IDE 文件定位", () => {
  it("保留 Windows/Linux 路径的空格、中文和百分号", () => {
    expect(codeossFilePath("C:\\我的项目", "src\\hello world%.ts")).toBe(
      "/C:/我的项目/src/hello world%.ts",
    );
    expect(codeossFilePath("/home/project/", "src/app.ts")).toBe("/home/project/src/app.ts");
  });
});
