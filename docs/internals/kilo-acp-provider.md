# Kilo ACP 接入与命令退出结果

核对日期2026-10-01，Windows x64，固定官方kilo.exe 7.8.1。当前通过既有通用ACP接入，本机自定义OpenAI兼容端点可以完成真实工具验证；没有调用Kilo账号认证或外部模型。全部44入口与最终独立审计仍保持原范围，此模块不证明总体完成。

## 调用与配置

acpAgent实例 → GenericAcpDriver → CursorAdapter → AcpSessionRuntime，复用已有工具、审批、动态配置与恢复链路，不增加Kilo专属Driver。固定命令kilo acp，本次额外使用官方--pure关闭外部插件。二进制和随附资产来自仓库外已有官方安装，本次不下载、安装或自动更新。

实际initialize为Kilo@7.8.1，广告kilo-login与loadSession=true。自定义provider使用内置@ai-sdk/openai-compatible；KILO_CONFIG指向独立kilo.json。不调用authenticate，实际session/new成功；这不证明Kilo Gateway账号认证通过。配置示例中模型ID、地址和Key需要替换，生产Key可按官方配置使用环境引用，不把合成示例Key写进生产配置：

```json
{
  "model": "codework-local/codework-loopback",
  "small_model": "codework-local/codework-loopback",
  "enabled_providers": ["codework-local"],
  "autoupdate": false,
  "share": "disabled",
  "plugin": [],
  "lsp": false,
  "formatter": false,
  "permission": "ask",
  "provider": {
    "codework-local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:<本机端口>/v1", "apiKey": "local-test-only" },
      "models": {
        "codework-loopback": {
          "name": "本机模型",
          "tool_call": true,
          "limit": { "context": 32768, "output": 4096 }
        }
      }
    }
  }
}
```

探针配置两个合成模型，实际默认模式code，切换模型后下一聊天/工具请求使用第二模型。Kilo会后台生成标题，独立small_model仍使用第一个模型；夹具仅按固定版本的两条消息、明确标题system/user前缀及无工具识别这一请求，其余请求继续严格校验当前聊天模型，标题不能消耗工具动作或充当恢复证据。

isolatedProbeEnvironment清空非系统宿主变量，覆盖HOME/USERPROFILE/APPDATA/LOCALAPPDATA；XDG配置/数据/缓存/状态也在独立目录。显式KILO_CONFIG、空KILO_CONFIG_CONTENT，以及关闭更新、默认插件、外部skills、LSP下载、项目配置和Claude配置。运行器设置合成宿主OPENAI_API_KEY与错误KILO_CONFIG，验证隔离配置生效。Scope拥有临时目录、CLI和随机127.0.0.1模型HTTP服务；Windows回收曾报EBUSY，现只对确认归属的独立临时目录使用Node标准库有限重试，最终回收失败仍报错。这是配置隔离，不是操作系统沙箱或网络封锁。

## 固定官方实际结果

| 项目                        | 本次证据与边界                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 版本与配置                  | 二进制SHA-256/大小、官方help、精确initialize；code模式、动态模型、非空命令目录通过；未执行全部模式/斜杠命令     |
| 正文与模型                  | 实际HTTP路径、合成Bearer、当前聊天模型及SSE正文；标题请求另按固定形状校验；通过本机端点，不是外部推理           |
| 读取/写入                   | 原生read/write工具；模型收到实际文件内容，工具详情含正文；原allow_once选项批准，精确写入APPROVED                |
| 命令成功/失败               | 原生bash执行echo标记与exit 7，检查输出及退出状态；非零失败且详情显示退出码，保留原completed帧                   |
| 拒绝                        | 原上游reject_once选项，目标文件不存在，实际工具failed                                                           |
| 审批中取消                  | 原审批请求的工具ID和目标路径、cancelled结果、文件不存在；此时尚无执行工具事件，不伪造失败工具；下一真实回合成功 |
| 恢复                        | 关闭原CLI后新进程session/load同ID；下一实际模型请求role=tool含之前读取正文才返回恢复标记；通过                  |
| MCP/媒体/外部账号/多端/远程 | 本轮未运行，不能据此宣称通过                                                                                    |

[KiloAcpToolProbe.test.ts](../../apps/server/src/provider/acp/KiloAcpToolProbe.test.ts)仅显式CODEWORK_KILO_CLI_PATH时运行，最终未插桩官方工具探针1项通过。12文件相关回归224项通过、普通未启用探针1项跳过，去重225项。Server类型检查、四变更TS定向lint与格式检查通过。旧KiloAcpCliProbe允许任意会话结果，原样保留，不纳入此提交或作为本次工具验收。

## 命令状态修复

实际exit 7终态省略kind，status=completed，但rawOutput.metadata.exit=7；原工具详情只有(no output)。KiloAcpToolResult在既有Runtime通知解析边界读取结构化退出码，0保持completed，非零归为failed，rawOutput增加exitCode，既有content末尾补显式退出码文字。原output/metadata/content与rawPayload保留，不重执行命令。只限定Kilo、completed和未指定或execute类型；其它Agent/类型/阶段、已有exitCode、缺字段或畸形数值不覆盖，不从stdout推断。原始失败和修复后正式探针分别留证。

三项定向回归覆盖真实省略kind形状、成功/已有字段/其它Agent边界、畸形或缺码；共用RPC/Adapter审批结算与取消回归同时通过。审批记录与执行工具分别展示，不能把仅审批的取消当作已经执行失败。修复后的状态与detail进入既有共用事件及显示链，本轮没有打开浏览器/Electron/手机，不将数据链验证当作多端视觉验收。

## 复验、来源与回滚

```powershell
$env:CODEWORK_KILO_CLI_PATH = '<固定7.8.1目录>/kilo.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/KiloAcpToolProbe.test.ts
Remove-Item Env:CODEWORK_KILO_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/KiloAcpToolResult.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts
```

检索词Kilo ACP custom provider KILO_CONFIG metadata.exit small_model title，访问2026-10-01。采用[官方CLI说明](https://kilo.ai/docs/code-with-ai/platforms/cli)、[固定7.8.1配置源码](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/config/config.ts)、[固定ACP服务](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts)、[固定标题模型选择](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/session/prompt.ts)，因为这些来源定义实际配置与生命周期；在线文档可漂移，当前结论以固定官方未插桩CLI与原始HTTP/文件/事件为据。通用入口与安装见[通用ACP实现](./generic-acp-provider.md)。

无新增依赖、密钥存储或数据库迁移，可独立撤回本提交；撤回后Kilo非零命令仍可能显示成功且退出码不可见，已保存实例和历史保留，已执行文件/命令副作用不会因代码撤回而撤销。真实账号、外部模型、MCP/媒体和各端各连接仍需各自证据，原44目标及A-8最终审计保持未完成。
