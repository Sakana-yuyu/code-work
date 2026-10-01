# Paseo A-8 历史审计线索（R109；非当前完成证明）

2026-10-01 更正：当前运行台账 A-8 未勾选，目标尚未完成。下文保留历史来源和陈述，但本页不是新鲜独立审核；任何旧勾选、marker或解锁命令都不能代替当前逐项验证。原始工作文件已在仓库外按字节留存。稳定验收合同见 [Agent入口与验收合同](./acp-provider-validation.md)。

**Date:** 2026-10-01  
**旧报告记载的范围调整（原始用户消息待核对）：** 「需要登录真实账户和实机验证的都跳过但是保证功能完整可用。」  
**旧报告记载的 A-5 调整：** 「能不能跳过真机」

**当前判定：** 旧报告不足以证明 A-1…A-8 全部完成。所有 A-N 须对照原 verify 逐项审核；明确范围调整还要关联原始人类消息和适用门槛，跳过真实验证不等于真实验证通过。

历史 marker（仅为本地记录，不自行构成授权或完成证据）：
- `.t3/paseo-unblock/a3-real-account-waived.json`
- `.t3/paseo-unblock/a5-physical-phone-waived.json`

---

## 历史勾选与当前门槛

| ID | State | Basis |
| --- | --- | --- |
| A-1 | 历史勾选，待最终复核 | Shared ACP fixture chain |
| A-2 | 历史勾选，待最终复核 | 44-entry catalog |
| A-3 | 历史勾选，待最终复核 | Copilot/Qwen/Cline/Hermes success + Gemini **auth-blocked/负向** documented; live Gemini success **not** claimed; override skips real-account login |
| A-4 | 历史勾选，待最终复核 | Four-state registration (未实测 allowed) |
| A-5 | 历史勾选，待最终复核 | Web+Electron+AVD; physical waived |
| A-6 | 历史勾选，待最终复核 | Native providers / BYOK |
| A-7 | 历史勾选，待最终复核 | Local+LAN+SSH OR |
| A-8 | 未完成 | 当前台账未勾选；缺覆盖全部 A-N 的新鲜最终独立审核，本页不能代替 |

---

## 历史功能线索（本页未重新验证）

| Area | Evidence |
| --- | --- |
| ACP core Runtime/Adapters | Focused `vp test run` R109 (see `%TEMP%/codework-paseo-unblock/r109-functional-tests.log`) |
| Gemini integration path | Generic ACP + settings/UI shortcuts + `GeminiAcpCliProbe` negative auth (version family assert); `gemini-acp-provider.md` + unlock cmd |
| Registry catalog Web/Mobile | `AcpRegistryCatalogPicker` / `AcpRegistryCatalogSection` tests |
| `binaryDistribution` in dist | `apps/server/dist/bin.mjs` contains symbol (R109 check) |
| Unlock for future credentials | `.t3/paseo-unblock/unlock-commands.json` + BLOCKED.md |

### 历史修改线索

1. **Windows favicon `sourcePath`** used `\` → clients expected posix `brand/custom.svg`. Fixed in `AssetAccess.ts`.
2. **GeminiAcpCliProbe** hard-pinned CLI `0.61.0` while PATH had `0.55.1` → false red. Assert `^0\.\d+\.\d+` family; catalog still documents pin 0.61.0.

---

## Explicit non-claims

- No live Gemini text/tool success with a real Google account.
- No claim that AVD equals a physical phone outside this goal’s waiver.
- Users with real keys still use unlock commands / `paseo-a3-gemini-probe.ps1`.

---

## 后续完成判断

不得据本页或旧勾选将目标标为完成。最终独立验证须逐条覆盖完整计划和 A-N，存在失败、缺失或范围不一致时保持未完成；复核既有证据，不用本页代替真实CLI、客户端、连接或明确用户范围调整。
