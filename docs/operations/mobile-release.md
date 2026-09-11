# 移动端 EAS 构建运维说明

移动端云端构建与 OTA 走 EAS，由 `.github/workflows/mobile-eas-production.yml` 驱动；PR 预览构建走 `mobile-eas-preview.yml`。

## 前提条件

- 仓库 secret `EXPO_TOKEN`：Exo access token，所属账号必须能访问下面的 EAS 项目。缺失时工作流的每一步都会静默跳过（历史上表现为 7–9 秒的绿色"成功"运行，实际什么都没做）。
- EAS 项目：`@sakana-yuyu/code-work`（projectId `3bc41c40-7ffe-4d80-8237-1a5a8dcd0220`，2026-09-11 重建；此前配置里继承的 `d763fcb8…` 是无权访问的死 ID）。`apps/mobile/app.config.ts` 中 `extra.eas.projectId` 与 `updates.url`（OTA 运行时地址）必须指向同一项目；`owner` 必须与账号实际大小写一致（`sakana-yuyu`）。

## 触发与对账

推送到 main 且触及 `apps/mobile/**`、`packages/**`、`scripts/**`、锁文件等路径时自动运行，逐平台对账：

1. 商店构建：最新 production 构建的 appVersion 与 `app.config.ts` 的 `version` 不同（或不存在）时，`eas build --profile production --auto-submit --no-wait` 调度新构建并提交（TestFlight + Play 内部 track）。
2. OTA：对每个平台生成 fingerprint，存在指纹匹配的已完成 production 构建时才 `eas update`，否则跳过并在 job 摘要中标注——避免把 JS 更新发布到无法安装它的二进制上。

`workflow_dispatch` 是手动覆盖（mode=build 直接构建、mode=update 强制 OTA；version 覆盖会先提交版本号）。

版本号策略：`appVersionSource: remote` + production profile `autoIncrement`，versionCode / buildNumber 由 EAS 按项目递增。

## 首次凭据设置（一次性，需人工）

新 EAS 项目没有任何商店凭据，非交互的 CI 构建不会自动补齐：

- **Android 构建签名**：EAS 已自动生成 keystore（2026-09-11），无需人工。
- **Android 提交 Play**：在 EAS 控制台（项目 → Credentials → Google Service Account Key）上传 Google Play 服务账号 JSON。缺失时 `--auto-submit` 报 `Google Service Account Keys cannot be set up in --non-interactive mode`，但构建本身照常调度。
- **iOS 构建与提交**：需要 Apple 分发证书与描述文件，覆盖三个 target（`com.codework.mobile`、`com.codework.mobile.sharing`、`com.codework.mobile.widgets`）。交互式运行一次 `eas build -p ios --profile production`，或在 EAS 控制台用 Apple API Key 配置。缺失时报 `Credentials are not set up. Run this command again in interactive mode.`，构建不会调度。
- **EAS 环境变量**：production 环境默认为空。Clerk Google 登录（`EXPO_PUBLIC_CLERK_GOOGLE_*`）与 OTLP 上报（`EXPO_PUBLIC_OTLP_*`）按需在 EAS 控制台配置。

## 已知边界

- 构建调度成功 ≠ 提交成功：`--auto-submit` 的凭据缺失会让 `eas build` 命令本身退出非零，工作流整体标红，但已上传的构建仍会在 EAS 上继续跑完。
- OTA 只有在对应平台存在指纹匹配的已完成构建后才会开始发布；首次构建完成前的推送都会跳过 OTA（属预期）。
