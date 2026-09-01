# Code Work 桌面端发布（云端打包）

CodexWork 桌面端发布已迁移到 GitHub Actions 云端打包，
工作流位于仓库根目录 `.github/workflows/release-desktop.yml`。本地上传 138 MB 安装包的流程不再需要。

## 触发方式

| 方式     | 操作                                                              | 结果                                                      |
| -------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 正式发布 | 推送 tag `desktop-v<版本>`（如 `desktop-v0.0.39`）                | 构建 Windows x64 安装包并自动创建 GitHub Release          |
| 演练     | Actions 页手动触发 `Code Work Desktop Release`，publish 不勾选    | 只构建，产物保存在 workflow artifact 里供下载验证，不发布 |
| 手动发布 | 手动触发并勾选 `publish`，填版本号（留空取 desktop package.json） | 等价于推 tag                                              |

```bash
# 正式发布示例
git tag desktop-v0.0.39
git push origin desktop-v0.0.39
```

## 产物（Release 附件）

- `Code-Work-<版本>-x64.exe` — NSIS 安装包（约 138 MB，未签名）
- `Code-Work-<版本>-x64.exe.blockmap` — 差量更新块映射
- `latest.yml` — Electron 自动更新元数据（更新探测入口，必须随 Release 发布）
- `SHA256SUMS.txt` — 全部附件校验和

## tag 命名空间（重要）

- `desktop-v*` → codework 桌面端（本工作流，根目录 release-desktop.yml）
- `v*` → 根目录 Wails"Cursor助手"线（根目录 build.yml）

两套 glob 互不匹配。**发布 codework 桌面端绝不推 `v*` tag**，否则两条产品线同时发包
（2026-08-31 发错线事故的根源）。

## 构建环境（云端自动处理）

- 标准 `windows-latest` runner（仓库为 public，免费）
- Vite+ 工具链（`voidzero-dev/setup-vp`，Node 版本取 `codework/package.json` engines）
- Rust stable（仅资源监视器，二进制有缓存，命中则跳过）
- 依赖/包缓存：vp 包缓存按 `pnpm-lock.yaml` 键控，Electron 运行时缓存

## 当前边界

- 仅 Windows x64；macOS/Linux 与 Azure Trusted Signing 未启用。
  需要时按上游 `codework/.github/workflows/release.yml` 扩展（签名密钥需配 GitHub secrets）。
- 未捆绑 WSL node-pty 预编译产物（--wsl-prebuild 未传），WSL 后端首次启动需自行编译；
  与本地构建产物一致。
- 桌面端应用内更新走 generic provider，指向 GitHub Release 下载地址即可被 electron-updater 探测。

## 本地构建（备用）

```bash
cd codework
pnpm run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version <版本>
# 产物输出到 codework/release/
```
