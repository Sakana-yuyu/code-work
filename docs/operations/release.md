# 桌面 Release 运维说明

> 本文只描述当前仓库的普通稳定版桌面发布流程。

## 发布范围

Release 工作流位于 `.github/workflows/release.yml`，只在推送稳定版本 tag 时触发：

```text
vX.Y.Z
```

当前没有定时发布、手动发布入口或 nightly 发布入口。`v*-nightly.*` tag 会被排除。

一次稳定版发布包含：

- macOS arm64 DMG；
- macOS x64 DMG；
- Linux x64 AppImage；
- Windows x64 NSIS 安装包；
- Electron 更新所需的版本清单和 blockmap；
- 一个 GitHub Release 及其构建附件。

Release 不执行以下操作：

- 不发布 npm CLI 包；
- 不部署 Web/Vercel；
- 不发布 AUR；
- 不发送 Discord 通知；
- 不执行 Finalize 回写或自动修改 `main`。

构建机器使用 GitHub-hosted runner。macOS 使用 `macos-15` 和 `macos-15-intel`，Linux 使用
`ubuntu-24.04`，Windows 使用 `windows-latest`。Relay 部署工作流仅保留手动触发，不属于普通
代码推送或桌面 Release。

## 发布前检查

Release 会先执行质量门禁，再开始桌面矩阵构建。质量门禁包括格式检查、类型检查和测试；任何一项
失败都不会创建 GitHub Release。

桌面 Release 不读取 Relay 部署状态，也不需要 Axiom、Cloudflare 或 Relay 凭据；因此它可以
独立完成普通本地/远程桌面包构建。需要更新 Relay 基础设施时，再手动运行
`.github/workflows/deploy-relay.yml`。

正式发布前确认：

1. 版本已经写入对应的包配置和更新逻辑；
2. 工作区中没有准备误提交的本地缓存或构建产物；
3. GitHub Actions 所需的生产配置和可选签名密钥已在仓库环境中配置；
4. 已经接受这是一次真实发布，而不是测试构建。

## 触发发布

稳定版 tag 推送后，GitHub Actions 会自动创建 Release 工作流：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

本仓库不提供不发布的 tag dry-run。不要使用测试版本号验证流程，因为符合规则的稳定 tag 会进入
真实构建和 GitHub Release 发布流程。

查看运行状态：

```bash
gh run list --workflow release.yml --limit 5
gh run view <run-id> --log-failed
```

完成后检查：

```bash
gh release view vX.Y.Z
```

确认四类桌面安装包、更新清单、blockmap 和 Linux WSL `node-pty` 辅助附件均已存在。

## 凭据与权限

GitHub Release 使用 Actions 的仓库权限。桌面代码签名和公证按平台按需读取 GitHub Actions
Secrets；未配置签名密钥时，构建仍可生成未签名产物，但不能把它们描述为已签名发布包。

普通构建、打包和 GitHub Release 不需要 npm 账户。只有以后明确恢复 npm Registry 发布时，才需要
npm 账户、包所有权和发布权限。

## 本地缓存边界

以下内容只允许存在于本地，不应提交：

- `node_modules/`、`.t3/`、`.codework/`；
- `dist/`、`build/`、`release/`、`release-local/`；
- Playwright 快照、报告和本地日志；
- `.env` 及其本地变体。

它们已经由根目录 `.gitignore` 覆盖。GitHub Actions 中临时生成的 `release-publish/` 和
`resource-monitor-publish/` 只存在于 runner 工作区，作为附件上传后随 runner 销毁，不会写回仓库。

## 手工回滚思路

如果构建失败，删除本地尚未推送的 tag 即可取消未触发的发布：

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

如果 GitHub Release 已经创建，应在 GitHub Release 页面删除该 Release 和附件，并根据需要重新推送
修复后的新版本号；不要复用已经公开给用户的版本号。
