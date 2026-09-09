import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";

export function workbenchResourceUri(uri: URI, capabilityBase: string, origin: string): URI {
  if (uri.scheme !== "vscode-remote") return uri;
  // CSS 字体和图片由浏览器直接读取，必须走已有会话校验的 HTTP 代理。
  const url = new URL(`${capabilityBase.replace(/\/$/, "")}/vscode-remote-resource`, origin);
  // URI.parse 会解码查询参数；在解析基础地址后编码路径，保留文件名中的 %、# 和 &。
  return URI.parse(url.href).with({ query: `path=${encodeURIComponent(uri.path)}` });
}
