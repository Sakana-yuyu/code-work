import { expect, it } from "vite-plus/test";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { workbenchResourceUri } from "./resourceUri";

it.each([
  ["http://localhost:5735", "/C:/中文 项目/extension/icons/seti.woff"],
  ["https://codework.example.test", "/home/project/icons/a%23 #&+.svg"],
])("远程图标通过 %s 的会话代理加载且不损坏路径", (origin, path) => {
  const uri = URI.from({ scheme: "vscode-remote", authority: "environment", path });
  const url = new URL(workbenchResourceUri(uri, "/api/ide/session/", origin).toString(true));

  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe("/api/ide/session/vscode-remote-resource");
  expect(url.searchParams.get("path")).toBe(path);
  expect([...url.searchParams.keys()]).toEqual(["path"]);
});

it.each([
  "https://example.test/icon.svg",
  "data:image/svg+xml,icon",
  "extension-file:/theme/icon.svg",
])("保留非远程资源 %s 的原有加载方式", (value) => {
  const uri = URI.parse(value);
  expect(workbenchResourceUri(uri, "/api/ide/session", "http://localhost:5735")).toBe(uri);
});
