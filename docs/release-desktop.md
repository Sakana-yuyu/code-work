# Code Work 桌面端发布

普通稳定版桌面发布由 GitHub Actions 云端构建并自动创建 GitHub Release。

## 触发方式

只推送三段式稳定版本 tag：

```bash
git tag v0.0.39
git push origin v0.0.39
```

符合 `vX.Y.Z` 的 tag 会触发 `.github/workflows/release.yml`。工作流不提供
nightly、手动 dry-run 或其他 tag 发布通道；`v*-nightly.*` 会被排除。

## 发布产物

一次稳定版 Release 包含以下 GitHub-hosted 构建产物：

- macOS arm64 DMG；
- macOS x64 DMG；
- Linux x64 AppImage；
- Windows x64 NSIS 安装包；
- Electron 自动更新所需的版本清单和 blockmap；
- 各平台资源监视器以及 Windows WSL 使用的 Linux x64 `node-pty` 辅助文件；
- `SHA256SUMS.txt` 校验和文件。

构建矩阵使用 `macos-15`、`macos-15-intel`、`ubuntu-24.04` 和
`windows-latest`。构建机器、依赖缓存和临时附件均由 GitHub Actions 托管。

## 发布边界

普通桌面 Release 只负责构建桌面安装包和发布 GitHub Release，不执行：

- npm CLI 发布；
- Web/Vercel 部署；
- AUR 发布；
- Discord 通知；
- Finalize 回写；
- Relay、Cloudflare 或 Axiom 基础设施部署。

桌面构建不依赖 Relay/Axiom/Cloudflare 凭据。未配置平台签名密钥时，仍会生成未签名
安装包；不能将未签名安装包描述为已签名版本。Relay 代码仍保留，若需要部署可在 Actions
中手动运行 `Deploy Code Work Connect relay`。

## 发布前检查

Release 会先通过格式检查、类型检查和测试，再并行构建四个平台。任一质量门禁或平台构建
失败，都不会创建正式 GitHub Release。

查看运行状态：

```bash
gh run list --workflow release.yml --limit 5
gh run view <run-id> --log-failed
gh release view v0.0.39
```

只有 `gh release view` 能看到 Release 不是草稿，并且四类平台附件、更新清单、blockmap
和校验和均存在时，才算发布完成。

## 本地构建（备用）

```bash
pnpm install
pnpm run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.39
```

本地构建产物写入 `release/`，该目录、`node_modules/`、`dist/`、`build/`、`.t3/`、
`.codework/`、`release-local/`、日志和 `.env` 文件都不应提交。

## 回滚

尚未触发工作流的本地 tag 可以删除：

```bash
git tag -d v0.0.39
git push origin :refs/tags/v0.0.39
```

已公开的 Release 不复用同一个版本号；应删除错误 Release 后使用修复后的新版本号重新
发布。
