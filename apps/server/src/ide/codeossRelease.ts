// VSCodium 官方 REH Web 制品；升级时同步验证启动钩子和扩展宿主协议。
// 客户端固定为 @codingame/monaco-vscode-api 33.0.9（基于 VS Code 1.121.0），
// 远程扩展宿主必须与之同一基线，commit 也随发布固定。
export const CODEOSS_VERSION = "1.121.03429";
export const CODEOSS_COMMIT = "824c4c46a288b839f13b24022655329c2aeb9f81";
const checksums: Readonly<Record<string, string>> = {
  "win32-x64": "45d1889c7a8a42552ca5e4aaae81817b8cc953915764f3f89360056c3933cf9d",
  "linux-x64": "48ff9b36fa069b7a2bfb40bb714b1beaebee782be92af311065ff1fcb9c0b3f8",
  "linux-arm64": "0d7307368f92bd896a48d605284cfba7dd5f9ef52ec7c7ff2a33f3917cd0c3fa",
  "darwin-x64": "2b21ce107f2dec54583c53b5f71182ee73508910f104e2872d14d52897ab870d",
  "darwin-arm64": "d0806e9a61ff4c9a658fdea790da6afd937499e1488e86252281a288e713188d",
};

export function codeossRelease(platform: string, arch: string) {
  const target = `${platform}-${arch}`;
  const sha256 = checksums[target];
  if (!sha256) throw new Error(`Code-OSS 暂无 ${target} 的已验证运行包。`);
  return {
    target,
    sha256,
    url: `https://github.com/VSCodium/vscodium/releases/download/${CODEOSS_VERSION}/vscodium-reh-web-${target}-${CODEOSS_VERSION}.tar.gz`,
  };
}
