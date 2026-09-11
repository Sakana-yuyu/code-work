# 移动端 EAS 构建运维说明

移动端云端构建与 OTA 走 EAS，由 `.github/workflows/mobile-eas-production.yml` 驱动；PR 预览构建走 `mobile-eas-preview.yml`。构建**不自动上架应用商店**——安装包在 EAS 控制台手动下载。

## 前提条件

- 仓库 secret `EXPO_TOKEN`：Expo access token，所属账号必须能访问下面的 EAS 项目。缺失时工作流的每一步都会静默跳过（历史上表现为 7–9 秒的绿色"成功"运行，实际什么都没做）。
- EAS 项目：`@sakana-yuyu/codework`（projectId `1a654c05-a3b5-4710-a083-72b35bbabd4d`，2026-09-11 由维护者创建并绑定；更早配置里继承的 `d763fcb8…` 是无权访问的死 ID）。`apps/mobile/app.config.ts` 中 `slug`、`extra.eas.projectId` 与 `updates.url`（OTA 运行时地址）必须指向同一项目；`owner` 必须与账号实际大小写一致（`sakana-yuyu`）。

## 触发与对账

推送到 main 且触及 `apps/mobile/**`、`packages/**`、`scripts/**`、锁文件等路径时自动运行，逐平台对账：

1. Production 构建：最新 production 构建的 appVersion 与 `app.config.ts` 的 `version` 不同（或不存在）时，`eas build --profile production --no-wait` 调度新构建。不上架、不提交商店；Android 产物为 **APK**（production profile 设了 `android.buildType: "apk"`，可直接安装；iOS 为 IPA），到 EAS 控制台下载。
2. OTA：对每个平台生成 fingerprint，存在指纹匹配的已完成 production 构建时才 `eas update`，否则跳过并在 job 摘要中标注——避免把 JS 更新发布到无法安装它的二进制上。

`workflow_dispatch` 是手动覆盖（mode=build 直接构建、mode=update 强制 OTA；version 覆盖会先提交版本号）。

版本号策略：`appVersionSource: remote` + production profile `autoIncrement`，versionCode / buildNumber 由 EAS 按项目递增。

## 凭据说明

- **Android 构建签名**：keystore 由 EAS 首次构建时自动生成，无需人工。
- **iOS 构建**：需要 Apple 分发证书与描述文件，覆盖三个 target（`com.codework.mobile`、`com.codework.mobile.sharing`、`com.codework.mobile.widgets`）。交互式运行一次 `eas build -p ios --profile production`，或在 EAS 控制台用 Apple API Key 配置。缺失时报 `Credentials are not set up. Run this command again in interactive mode.`，iOS 构建不会调度（Android 不受影响）。
- **EAS 环境变量**：production 环境默认为空。Clerk Google 登录（`EXPO_PUBLIC_CLERK_GOOGLE_*`）与 OTLP 上报（`EXPO_PUBLIC_OTLP_*`）按需在 EAS 控制台配置。
- 如将来要恢复自动上架（TestFlight / Play 内部 track）：把 `--auto-submit` 加回两处 `eas build`，production profile 的 `android.buildType` 改回 `app-bundle`，并在 EAS 控制台配好 Apple API Key 与 Google Play 服务账号 JSON；`eas.json` submit 段的 `ascAppId` 是上游遗留值，恢复 iOS 提交时需换成自己的 App Store Connect 应用 ID。

## 已知边界

- OTA 只有在对应平台存在指纹匹配的已完成构建后才会开始发布；首次构建完成前的推送都会跳过 OTA（属预期）。
- 免费版每个账号同时只能跑一个构建；换绑项目前先取消旧项目的在跑构建。
