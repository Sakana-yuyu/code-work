# Factory Droid ACP 接入与认证边界

核对日期2026-10-01，Windows x64，固定官方droid@0.229.0的bin/droid.exe。当前可配置通用ACP实例并握手；无认证的公共版在session/new阶段明确拒绝。没有文本/工具/真实账号验收，本页不把握手或负向测试称为工具接入完成。历史401、session/new成功记录不能替代本次隔离证据；全部44入口与最终审计仍保持原范围。

## 入口与调用

保存为既有acpAgent实例，使用GenericAcpDriver → CursorAdapter → AcpSessionRuntime公共链路，不增加Factory专属驱动或状态。调用droid.exe exec --output-format acp-daemon；目录命令和启动参数由[通用ACP向导](./generic-acp-provider.md)处理。原npm shim缺少native分发时不能启动，当前使用仓库外已有官方native资产，不在测试中下载、更新或执行postinstall。

实际initialize返回agentInfo.name=@factory/cli、version=0.229.0，广告device-pairing与factory-api-key。省略authenticate仍会在session/new检查认证，不等于匿名可用。有效Factory账号或API key应按官方方式在所选服务器环境配置；测试不会填虚构Factory密钥、复制账号或打印设备授权码。本次合成宿主FACTORY_API_KEY被显式清空，原本宿主已有设置不参与验证。

## 本次固定版本结果

| 路径                          | 当前证据                                                                                                  | 结论                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 已安装与版本                  | 当前仓库外native --version=0.229.0，记录完整二进制SHA-256/大小                                            | 已安装检测；不是所有平台安装证明                  |
| 实际握手                      | initialize成功，精确版本及两种认证方法断言                                                                | 通过                                              |
| 无认证会话                    | 原生session/new返回AcpRequestError，code=-32000，Authentication required前缀                              | 明确认证阻断，工具未可用                          |
| BYOK本机配置                  | 独立settings.json配置generic-chat-completion-api、本机模型端点/合成模型Key，仍在session/new遇同类认证阻断 | BYOK不能据此当作无需Factory账号；本次没有模型请求 |
| 文本/读写/命令/审批/取消/恢复 | 模型会话未建立，工具步骤没有运行                                                                          | 未验证，不能记为通过                              |
| MCP关闭/默认/开启             | 当前HEAD的GenericAcpDriver.settings.test真实协议子进程分别验证false/缺省/true的新建与恢复报文             | 共用合同通过；非真实Droid MCP工具调用             |
| Web/Desktop/Mobile/远程       | 本轮未运行                                                                                                | 未验证                                            |

FactoryDroidAcpCliProbe.test.ts现在是明确的固定版本无认证检查：initialize必须成功，session/new必须以指定认证错误失败，不接受成功/失败任一结果，不发送authenticate或session/prompt，且new请求mcpServers为空。仅提供CODEWORK_FACTORY_DROID_CLI_PATH时启用；普通测试跳过不算通过。

独立HOME/USERPROFILE/APPDATA/LOCALAPPDATA及工作目录复用isolatedProbeEnvironment，空置非系统宿主变量，Scope负责自身临时目录与子进程收尾，没有吞清理异常。Droid 0.229.0用空SHELL覆盖COMSPEC的默认解析，清空环境后会Failed to resolve shell executable，因此仅为该Windows探针显式指定SHELL=COMSPEC；不能改用用户完整环境制造通过。禁用自动更新，不宣称公共二进制是无网络离线构建，也不是操作系统沙箱。

当前相关回归18项通过、1项未启用官方探针跳过；真实官方负向探针单独1项通过，去重19项。Server类型检查、探针定向lint和格式检查通过。准备阶段本机模型工具探针因认证阻断失败，该失败只作为限制证据，工具断言未执行，未把它改名计为成功工具探针。曾误用requestLogger.params，按真实合同payload修正后正式复验。

## MCP兼容默认

Factory目录的supportsMcpServers=false是从Paseo固定目录继承的兼容默认，已在当前HEAD实现；不是永久禁止厂商MCP。用户可以显式启用，GenericAcpDriver将实例设置传给CursorAdapter唯一注入入口，新建和恢复使用同一过滤结果。关闭时不向ACP发送Code Work MCP服务器及其认证头；缺省/true保持原注入。没有改变标准fs/terminal或审批接口，文本生成原本不注入MCP。

当前Factory官方Zed说明支持context_servers；因此“目录默认关闭”与“厂商完全不支持MCP”必须区分。真实Factory MCP会话/工具仍需认证后核对，不能用其它Agent或fixture的成功代替。详见[实例设置](../../apps/server/src/provider/Drivers/GenericAcpDriver.settings.test.ts)与[目录解析](../../apps/server/src/provider/acp/AcpRegistryCatalog.ts)。

## 复验、来源与回滚

```powershell
$env:CODEWORK_FACTORY_DROID_CLI_PATH = '<固定0.229.0目录>/node_modules/droid/bin/droid.exe'
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/FactoryDroidAcpCliProbe.test.ts
Remove-Item Env:CODEWORK_FACTORY_DROID_CLI_PATH
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/Drivers/GenericAcpDriver.settings.test.ts apps/server/src/provider/acp/AcpRegistryCatalog.test.ts
```

检索词Factory Droid ACP custom models、BYOK、MCP Zed、Airgapped deployment，访问2026-10-01。采用[官方BYOK配置](https://docs.factory.com/model-independence/byok)、[官方Exec与ACP限制](https://docs.factory.com/droid-exec/overview)、[官方IDE/MCP说明](https://docs.factory.com/ide-integrations)与[官方Airgap说明](https://docs.factory.com/enterprise/airgapped-deployment)，因为这些定义配置、能力和分发边界。当前在线说明和固定0.229.0可能不同，实际结论来自固定binary/隔离请求；help exec有效，而exec --help在空SHELL时会加载环境后失败。固定帮助使用--only-tools，与当前网页--restrict-tools不同，不能直接套新版参数。

官方Airgap是企业单独构建、不通过公共下载分发，不是随意设置环境变量就能去掉公共版认证。官方BYOK支持本地模型并不保证公共ACP匿名可用；本次原始认证失败仍需保留。待获得获授权的Factory测试登录后，应继续验证文本、读取、允许写入、命令成功/失败、拒绝、取消、历史恢复、实际MCP和多端结果；本模块不能替代这些尚未完成的证据。

无依赖、账户或数据库迁移，未改生产MCP/Driver逻辑。可独立撤回本探针和文档提交；已保存实例及历史不删除，此前MCP开关/通用ACP修复保留。真实认证阻断不会因撤回测试而解除。
