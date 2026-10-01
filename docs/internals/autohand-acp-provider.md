# Autohand ACP 接入与验证边界

核对日期：2026-09-30。固定官方目录版本 `0.2.1`（registry `autohand` / npm `@autohandai/autohand-acp`）。本页记录适配器握手；不代表底层 Autohand CLI 或工具验收。

## 调用与配置

命令为适配器包入口（目录 `npx -y @autohandai/autohand-acp@0.2.1`）。`initialize` 可在**未**安装底层 Autohand CLI 时通过；此时广告 `authMethods=[{id:autohand-install}]`。

## One-shot 解锁（升真实可用前）

```powershell
# 1) 按官方文档安装底层 Autohand CLI，并完成安装/登录流（auth=autohand-install）
# 2) 再跑 ACP ToolProbe（文本 + 读/写副作用）
$env:CODEWORK_AUTOHAND_CLI_PATH = 'C:\codework-cli-iso\autohand-0.2.1\node_modules\@autohandai\autohand-acp\…'
.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/AutohandAcpCliProbe.test.ts
```

仅适配器握手 **≠** 真实可用。

## 固定版本证据

| 项目 | 结果 |
| --- | --- |
| initialize | name/version 匹配 0.2.1；缺底层 CLI 时 auth=`autohand-install` |
| 工具 / prompt | 未实测 |

## 后续与回滚

底层 CLI + 认证完成后再验工具。回滚撤回说明；无迁移。
