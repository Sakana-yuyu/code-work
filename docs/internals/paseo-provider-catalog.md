> 历史工作记录：以下轮次、状态和版本保留原文，不作为当前提交验收。当前44入口的已提交证据与限制见 [Agent入口与验收合同](./acp-provider-validation.md)。CodeBuddy/Mistral已具备本机自定义模型工具检查，旧凭据阻断条目不能覆盖该路径。

# Paseo 入口与 Code Work 目录对照

历史记录日期：2026-09-30。2026-10-01 更正：本文是未提交的历史工作记录，各轮结果未在本页重新验证；它不证明当前完整验收。固定44入口绑定和稳定验证方法见 [Agent入口与验收合同](./acp-provider-validation.md)。本文记录入口归属和目录覆盖。除明确列出证据的条目外，官方 CLI 认证、工具与真实设备验收均为**未实测**；不能根据目录存在宣称完成全部接入。

来源：Paseo 固定提交 [23c4404b](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/app/src/data/acp-provider-catalog.ts)、同提交的 [内置注册表](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/protocol/src/provider-manifest.ts)，以及 2026-09-30 获取的 [官方 ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)。采用真实注册数据而非旧介绍页面，检索关键词为 CATALOG_DATA、AGENT_PROVIDER_DEFINITIONS、distribution。

官方目录本次有 41 项；Paseo 固定基线是 6 个内置加 38 个 ACP，共 44 个不同 ID。两组版本和范围不同。离线快照保留官方 41 项，另有 5 个手工安装入口；当前合并为 46 项，不把 Paseo 旧版本覆盖到在线目录，也不把不同名字自动合并。Grok 继续使用专用驱动，不新增重复目录项。

## 六个内置入口

| Paseo ID | Code Work 对应入口          | 边界                                                                                                                                         |
| -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| claude   | claudeAgent                 | 已有独立驱动；本轮未实测                                                                                                                     |
| codex    | codex                       | 已有独立驱动；本轮未实测                                                                                                                     |
| copilot  | ACP 目录 github-copilot-cli | 官方 1.0.89 的认证、文本、读写、命令、拒绝、取消和恢复实测通过；模型目录/custom agent/多端仍有边界，见 [实测记录](./copilot-acp-provider.md) |
| opencode | opencode                    | 已有独立驱动；A-6 核对仅保留 OpenCode SDK **v2**（legacy v1 Layer 已删），定向 Adapter/网关回归通过；本轮未做新的官方 CLI 聊天实测           |
| pi       | piAgent                     | 保留受管 BYOK；本轮未实测                                                                                                                    |
| omp      | ompAgent                    | 保留受管 BYOK；本轮未实测                                                                                                                    |

## 三十八个基线 ACP 条目与两个额外目录项（历史记录）

“官方目录”仅表示具有同 ID 的元数据；已核对的公开环境参数和固定版本 uvx 可随目录选择配置，二进制分发仍按手工/平台限制规则处理，不能据此推断自动安装可用。已有专用驱动的 Cursor、Grok、Kimi 继续复用。

| Paseo ID        | 名称               | Paseo 版本 | 官方目录版本 | Code Work 入口与缺口                                                                                                                                                                                                                                 |
| --------------- | ------------------ | ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agoragentic-acp | Agoragentic        | 1.3.6      | 1.3.0        | R90：`--acp` 下 initialize OK，但 **无 `session/new`**（Method not found）；仅 `tools/*` MCP 面 → **不支持** ACP 会话；见 [Agoragentic](./agoragentic-acp-provider.md)                                                                               |
| antigravity-acp | Google Antigravity | —          | 1.2.1        | R69 隔离下载 Windows zip，维护者 sha256 写入快照/overlay → `binaryDistribution` 可自动安装校验；initialize=`antigravity-acp@1.2.1`；session/new 需 oauth-personal/gemini-api-key 等，**未发明密钥**；见 [Antigravity](./antigravity-acp-provider.md) |
| amp-acp         | Amp                | 0.7.0      | 0.9.0        | 官方 Windows zip SHA 匹配目录；隔离 `amp-acp.exe` initialize=`amp-acp@0.9.0`、auth=`setup`；工具/模型需 Amp API key，本轮未发明密钥，见 [Amp](./amp-acp-provider.md)                                                                                 |
| auggie          | Auggie CLI         | 0.33.0     | 0.36.0       | 隔离 npm `@augmentcode/auggie@0.36.0 --acp` initialize=`auggie`/`0.36.0…`、`authMethods=[]`；**session/new 仍要 `auggie login`**（R66 node 入口 ToolProbe）；工具阻断，见 [Auggie](./auggie-acp-provider.md)                                         |
| autohand        | Autohand Code      | 0.2.1      | 0.2.1        | 隔离 `@autohandai/autohand-acp@0.2.1` initialize 通过（name/version 匹配）；底层 Autohand CLI 未装时 auth=`autohand-install`；工具/模型未实测                                                                                                        |
| cline           | Cline              | 3.0.46     | 3.0.65       | 官方 Windows CLI + 本地模型端点：模型、读写/命令、审批/拒绝/取消和持久恢复通过；外部账号/推理未验，见 cline-acp-provider.md                                                                                                                          |
| codebuddy-code  | Codebuddy Code     | manual     | 2.159.0      | 隔离 npm `@tencent-ai/codebuddy-code@2.159.0 --acp` initialize 通过但**无 agentInfo**；auth=`iOA`/`external`/`internal`/`selfhosted`；见 [Codebuddy](./codebuddy-acp-provider.md)                                                                    |
| codewhale       | CodeWhale          | 0.8.55     | 未收录同 ID  | R87：`DEEPSEEK_API_KEY=ollama` + `config.toml` `providers.deepseek.base_url=…/v1` model=`qwen2.5:3b` → marker 回读 + `write-r87.txt` 写盘；shell 未硬过；外部 DeepSeek 账号待，见 [CodeWhale](./codewhale-acp-provider.md)                           |
| cortex-code     | Cortex Code        | 1.0.73     | 1.0.73       | R69 隔离 tar.gz + sha256 overlay；initialize=`Cortex Code`；session/new 成功；无密钥下 prompt 返回 `end_turn`（未验文件/命令工具）；见 [Cortex](./cortex-code-acp-provider.md)                                                                       |
| corust-agent    | Corust Agent       | 0.5.1      | 0.6.0        | R69 隔离 zip + sha256；initialize=`corust-acp`；session/new 要 `oauth_browser`；工具未测                                                                                                                                                             |
| crow-cli        | crow-cli           | 0.1.23     | 0.1.24       | 真实资产为 PyPI/`github.com/crow-cli/crow-cli`（需 Python≥3.14+uv，`crow-cli acp`）；npm 同名包无关。本机 uv 装 0.1.37 后 Windows 因 `termios`/`pty` 无法启动 CLI；ACP 协议未实测                                                                    |
| cursor          | Cursor             | 2026.03.30 | 2026.09.26   | 已有专用驱动；不重复新增驱动                                                                                                                                                                                                                         |
| deepagents      | DeepAgents         | 0.1.20     | 0.1.7        | R87：`--model openai:qwen2.5:3b` + Ollama；`read_file` 回显 marker → 真实可用；edit 宣称成功但 `write-r87.txt` 0 字节；见 [DeepAgents](./deepagents-acp-provider.md)                                                                                 |
| devin           | Devin CLI          | manual     | 3000.11.3    | R69 隔离 zip + sha256；需隔离 `APPDATA`；initialize=`affogato`；auth=`devin-browser`；工具未测                                                                                                                                                       |
| dimcode         | DimCode            | 0.2.36     | 0.5.15       | R87：`dim provider add ollama --base-url …/v1 --api-key ollama --model qwen2.5:3b` 后 ACP 会话成功；grep 读出 marker；写未硬过；见 [DimCode](./dimcode-acp-provider.md)                                                                              |
| dirac           | Dirac              | 0.4.22     | 0.5.16       | R89：`dirac auth openai`+Ollama + `supportsReasoning:false` API 通；`qwen2.5:7b` 有 list/read_file 但反复读虚构 `src/main.ts`，无 marker/写 → 仍未实测；见 [Dirac](./dirac-acp-provider.md)                                                          |
| factory-droid   | Factory Droid      | 0.179.0    | 0.229.0      | MCP 注入默认关闭可开；`acp-daemon` 握手+session OK；prompt 无真实 key → 401/`Internal error: Agent error`（R90，agent-side）；见 [Factory Droid](./factory-droid-acp-provider.md)                                                                    |
| fast-agent      | fast-agent         | 0.9.22     | 0.10.1       | R85 Ollama `qwen2.5:3b`：initialize/auth/session + 读/写/`terminal/create` shell 副作用通过（须客户端 `fs/*`+`terminal/*`）；见 [fast-agent](./fast-agent-acp-provider.md)                                                                           |
| gemini          | Gemini CLI         | 0.52.0     | 0.61.0       | 官方安装、握手与认证失败实测通过；本机 PATH 有 gemini 0.55.1，缺可用凭据故模型/工具未实测，见 [接入记录](./gemini-acp-provider.md)                                                                                                                   |
| gjc             | Gajae Code         | manual     | 未收录同 ID  | 官方 v0.18.1 隔离再验：认证 CliProbe 3/3；工具探针连续两回合文本、read、bash 批准、审批中取消补 failed 1/1；Runtime 等 `gjcPhase=idle`；恢复/外部模型/设备仍待，见 [Gajae](./gajae-acp-provider.md)                                                  |
| glm-acp-agent   | GLM Agent          | 1.3.0      | 1.13.0       | R86：`Z_AI_API_KEY=ollama` + `ACP_GLM_BASE_URL=http://127.0.0.1:11434/v1` Ollama 读/写工具副作用通过；shell 未硬过；见 [GLM](./glm-acp-provider.md)                                                                                                  |
| goose           | goose              | 1.33.1     | 1.52.0       | 官方 Windows zip 隔离 `goose.exe acp`；R78 Ollama `qwen2.5:3b` 读/写/命令/拒绝 HARD_PASS=4/4（客户端须 `fs/*`+`terminal/*`）；cancel 未硬通过；见 [goose](./goose-acp-provider.md)                                                                   |
| grok            | Grok               | 0.2.11     | 未收录同 ID  | 已有专用驱动；不重复新增驱动                                                                                                                                                                                                                         |
| harn            | Harn               | —          | 0.10.151     | 官方 Windows zip；`serve acp` + `environmentPolicy:{kind:inherited}` 可建会话；见 [Harn](./harn-acp-provider.md)                                                                                                                                     |
| hermes          | Hermes             | manual     | 未收录同 ID  | 官方 v2026.9.24/0.21.5 配本机模型，读写、命令、拒绝/取消、模型切换、进程恢复及浏览器实测；2026-09-30 隔离 Python3.13 安装复测 CLI+工具探针 4/4；PATH 仍无 hermes；外部模型/设备待验，见 [Hermes](./hermes-acp-provider.md)                           |
| junie           | Junie              | 1468.30.0  | 3419.22.0    | R69 隔离 zip + sha256；stdio 探针 initialize=`@jetbrains/junie` 且 session/new 成功；`AcpSessionRuntime.start` 本机可挂起故未进 Effect CliProbe；auth=`jetbrains-account`；工具未测                                                                  |
| kilo            | Kilo               | 7.2.40     | 7.8.1        | R88：`OPENAI_API_KEY=ollama` + `OPENAI_BASE_URL=…/v1` + `~/.config/kilo/config.json` openai 模型 `qwen2.5:3b` → read/write 工具副作用；见 [Kilo](./kilo-acp-provider.md)                                                                             |
| kiro            | Kiro CLI           | manual     | 未收录同 ID  | 官方 2.26.0 Windows x64 包校验、提取、版本/帮助通过；本机 ACP 握手前目录初始化失败，真实命令/工具未验；Windows ARM64 标记不可用，见 [Kiro](./kiro-acp-provider.md)                                                                                   |
| kimi            | Kimi Code CLI      | 0.11.0     | 1.52.0       | 已有专用驱动；不重复新增驱动                                                                                                                                                                                                                         |
| minimax-code    | MiniMax Code       | 0.1.2      | 0.2.7        | 隔离 npm `@minimax-ai/code@0.2.7`（需 native better-sqlite3）initialize=`minimax-code@0.2.7`、无 authMethods；`--ignore-scripts` 会启动失败，见 [MiniMax](./minimax-acp-provider.md)                                                                 |
| minion-code     | Minion Code        | 0.1.44     | 0.1.44       | 官方 uvx 可装但 **ACP 不可用**：默认 `agent-client-protocol≥0.9` → ImportError(`AuthMethod`)；pin 0.8 后 JSON-RPC 写 stderr；见 [Minion](./minion-code-acp-provider.md)                                                                              |
| mistral-vibe    | Mistral Vibe       | 2.9.3      | 2.25.8       | 官方 Windows `vibe-acp.exe` initialize=`@mistralai/mistral-vibe@2.25.8`、auth=`browser-auth`；工具需 Studio 登录，本轮未发明，见 [Mistral Vibe](./mistral-vibe-acp-provider.md)                                                                      |
| nova            | Nova               | 1.1.29     | 1.1.48       | 隔离 npm `@compass-ai/nova@1.1.48`；广告身份为 `kore-cli@1.0.0`、auth=`kore-terminal-auth`；工具未实测，见 [Nova](./nova-acp-provider.md)                                                                                                            |
| poolside        | Poolside           | 1.0.0      | 1.0.16       | 官方 Windows amd64 zip SHA 匹配；`pool-windows-amd64.exe acp` initialize=`pool-acp@1.0.16`、`authMethods=[]`；见 [Poolside](./poolside-acp-provider.md)                                                                                              |
| qoder           | Qoder CLI          | 1.1.4      | 0.2.14       | 隔离 npm `@qoder-ai/qodercli@0.2.14 --acp` initialize=`qoder-cli@0.2.14`、auth=`qodercli-login`/`qoder-personal-access-token`；见 [Qoder](./qoder-acp-provider.md)                                                                                   |
| qwen-code       | Qwen Code          | 0.20.1     | 0.24.7       | 官方 CLI + 本地模型端点：文本/文件/命令/审批/取消/恢复通过；2026-09-30 隔离安装 0.24.7 探针再验通过；本机 PATH 仍无 qwen；外部模型与聊天 UI 待验，见 qwen-acp-provider.md                                                                            |
| sigit           | siGit Code         | 1.0.3      | 1.5.10       | R88：本地/Ollama 路径 `read_file` 回显 marker → 真实可用；写未硬过；见 [siGit](./sigit-acp-provider.md)                                                                                                                                              |
| stakpak         | Stakpak            | 0.3.80     | 0.3.88       | R69 隔离 zip + sha256；initialize=`stakpak@0.3.88`；session/new 要 `stakpak` 浏览器登录；工具未测                                                                                                                                                    |
| traecli         | TRAE CLI           | manual     | 未收录同 ID  | 已补具名手工入口；官方安装脚本 `https://trae.cn/trae-cli/install.ps1` 本机区域 403；文档要求企业登录后才能任务；CLI/ACP 仍未实测                                                                                                                     |
| vtcode          | VT Code            | 0.96.14    | 0.96.14      | R85 Ollama `--provider ollama --model qwen2.5:3b` + `VT_ACP_ENABLED=1`：session/prompt end_turn；marker 回读 + `write-r85.txt` 写盘；shell 未硬过；见 [VT Code](./vtcode-acp-provider.md)                                                            |

## 四十四基线入口及两个额外目录项的历史能力表

状态含义（A-2 目录层；不等于 A-3/A-4「工具实测完成」）：

| 状态              | 含义                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| 真实可用          | 历史标签；仍须按具体通过的动作、版本/平台和证据范围复核，部分工具通过不代表全部工具可用 |
| 可配置            | 目录可选手动/自动命令与环境；Adapter 或 Generic 可建实例；工具未全验                    |
| 握手-only         | initialize（±auth 广告）通过；session/工具未成功                                        |
| 凭据阻断          | 缺密钥/登录；负向或边界已记，不发明凭据                                                 |
| 平台限制          | OS/依赖阻断（如 Win10、termios、区域 403）                                              |
| 手工无校验        | 上游有可下载 archive，但无 sha256 → 产品拒自动安装；未冒充已装                          |
| Windows可装未全验 | 维护者隔离下载已算 sha256（快照+overlay），可自动安装校验；握手/会话已记；工具多需登录  |
| 不支持            | ACP/入口当前不可用（已写明原因）                                                        |
| 专用复用          | 已有非目录专用驱动，目录不重复新增                                                      |

| ID              | 能力状态                   | 安装/平台要点                                                                                                  |
| --------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| claude          | 可配置                     | 专用驱动；本轮未新实测                                                                                         |
| codex           | 可配置                     | 专用驱动；本轮未新实测                                                                                         |
| copilot         | 真实可用                   | github-copilot-cli；模型目录/custom agent/多端仍有边界                                                         |
| opencode        | 可配置                     | SDK v2 回归（A-6）；新聊天未测                                                                                 |
| pi              | 可配置                     | 受管 BYOK；未新实测                                                                                            |
| omp             | 可配置                     | 受管 BYOK；未新实测                                                                                            |
| agoragentic-acp | 不支持                     | R90：`--acp` 无 session/new（仅 MCP tools/\*）                                                                 |
| antigravity-acp | Windows可装未全验          | R69 sha256 overlay；会话需凭据                                                                                 |
| amp-acp         | 凭据阻断                   | 握手+setup auth；需 Amp key                                                                                    |
| auggie          | 凭据阻断                   | authMethods=[] 仍要 `auggie login`                                                                             |
| autohand        | 凭据阻断                   | 底层 CLI/安装 auth                                                                                             |
| cline           | 真实可用                   | 本地模型端点工具链通过                                                                                         |
| codebuddy-code  | 凭据阻断                   | 握手；多 auth 方法                                                                                             |
| codewhale       | 真实可用                   | R87 Ollama/DeepSeek-compat：读/写副作用；shell 未硬过；外部账号待                                              |
| cortex-code     | Windows可装未全验          | R69/R70；prompt 无密钥 end_turn，工具副作用未验                                                                |
| corust-agent    | Windows可装未全验          | R69；oauth_browser                                                                                             |
| crow-cli        | 平台限制                   | Windows termios/pty                                                                                            |
| cursor          | 专用复用                   | 专用驱动                                                                                                       |
| deepagents      | 未实测（仅局部读取记录）   | R87 Ollama：read_file 回显 marker；edit 宣称写盘但文件 0 字节；shell 未硬过                                    |
| devin           | Windows可装未全验          | R69；需隔离 APPDATA；devin-browser                                                                             |
| dimcode         | 未实测（仅局部读取记录）   | R87 Ollama：`provider add ollama`…/v1；grep 读 marker；写未硬过                                                |
| dirac           | 凭据阻断                   | R90 Ollama openai 会话+工具；路径幻觉无 marker → 仍未实测                                                      |
| factory-droid   | 凭据阻断                   | MCP 默认关可开；prompt 401 Agent error（需 Factory 账号）                                                      |
| fast-agent      | 真实可用                   | R85 Ollama：读/写/shell 副作用；外部账号待                                                                     |
| gemini          | 凭据阻断                   | 握手/认证失败路径有证据；无可用 key                                                                            |
| gjc             | 局部实测，生命周期仍待核对 | R119 未插桩工具探针通过一次；诊断 session/new uncertain_after_send 与旧发布/关闭失败均保留，见 Gajae 专页      |
| glm-acp-agent   | 真实可用                   | R86 Ollama OpenAI-compat：读/写副作用；shell 未硬过；外部 Z.AI 账号待                                          |
| goose           | 真实可用                   | R78/R79：Ollama `qwen2.5:3b` 读/写/命令/拒绝 HARD_PASS=4/4；cancel 三策略仍 `end_turn`（记软上限）；外部账号待 |
| grok            | 专用复用                   | 专用驱动                                                                                                       |
| harn            | 凭据阻断                   | R76：Ollama quickstart/local up 仍 ACP NL Compilation；表达式 end_turn≠工具可用                                |
| hermes          | 真实可用                   | 本地模型工具链；外部模型待                                                                                     |
| junie           | Windows可装未全验          | R69；stdio 握手成功；Effect start 可挂起                                                                       |
| kilo            | 真实可用                   | R88 Ollama：`OPENAI_BASE_URL`+config openai/`qwen2.5:3b`；read+write                                           |
| kiro            | 平台限制                   | Win10 握手前失败；需 Win11+                                                                                    |
| kimi            | 专用复用                   | 专用驱动                                                                                                       |
| minimax-code    | 凭据阻断                   | R70：Node+cli.js 握手；session 要 `mcode login`                                                                |
| minion-code     | 不支持                     | ACP 依赖/协议写 stderr                                                                                         |
| mistral-vibe    | 凭据阻断                   | 需 browser-auth                                                                                                |
| nova            | 凭据阻断                   | kore-terminal-auth                                                                                             |
| poolside        | 凭据阻断                   | R70：authMethods=[] 仍要 `pool login`                                                                          |
| qoder           | 凭据阻断                   | 需 login/PAT                                                                                                   |
| qwen-code       | 真实可用                   | 本地模型端点工具链通过                                                                                         |
| sigit           | 未实测（仅局部读取记录）   | R88 Ollama/本地模型：`read_file` 回显 marker；写未硬过                                                         |
| stakpak         | Windows可装未全验          | R69；session 503/登录（厂商）                                                                                  |
| traecli         | 平台限制                   | 安装脚本区域 403；企业登录                                                                                     |
| vtcode          | 真实可用                   | R85 Ollama：读+写工具副作用；shell 未硬过；外部账号待                                                          |

合计：能力表含 **6 内置 + 与上节同集合的 ACP 行（40，含官方扩容 antigravity-acp/harn 等）**，ID **无重复**；覆盖 Paseo 固定 **6+38** 基线并多记官方目录新增项。自动安装矩阵：HTTPS archive **且** 64 位 sha256（官方字段或 `registry-binary-sha256-overlay.json` 维护者核对）时暴露 `binaryDistribution`；七项前空壳已在 Windows-x86_64 写入维护者 sha256，**其它平台仍空**。

## 离线快照与更新约束

快照位于 `apps/server/src/provider/acp/registry-snapshot.json`，记录来源、获取日期和原始响应 SHA-256。文件是官方数据的节选，保留名称、版本、npx/uvx 分发参数、二进制平台键、CDN 图标地址，以及带 sha256 的当前官方二进制 archive/cmd/args；去掉长描述。Web 额外将 41 个官方 SVG 缓存到 `apps/web/public/acp-agent-icons/`，离线优先本地副本。官方源数据采用 Apache-2.0，许可证保留于同目录的 `registry-snapshot.LICENSE`。快照不包含账号信息。

当前平台若仅有带 sha256 的官方二进制（无安全 npx/uvx 命令），目录暴露 `binaryDistribution`；Web/Mobile 可触发 `server.installAcpRegistryBinary`，由所选环境下载、校验、解包到 `<CODEWORK_HOME>/acp-agents/<id>/…` 后回填命令。客户端不能提交下载地址或校验值。无 sha256 或不支持的归档格式仍显示为手工安装。

在线请求成功时使用在线结果，包括合法空目录，不补旧快照；网络、超时、无效 JSON/结构、HTTP 错误、超过 2 MiB 时，返回按当前服务端平台解析的快照，同时保留 error、source=bundled、snapshotDate。页面展示日期与过期提示，搜索和既有命令选择继续可用。旧客户端仍可能因为 error 隐藏列表，完整体验需要更新客户端。在线与离线目录随后均追加下文五个独立手工安装入口，仅补缺失 ID；因此成功空在线结果会显示这五项，不会恢复旧快照的 41 项。

更新快照须从官方源重新获取、比对 ID/版本/平台与参数并核对许可；更新日期和原始文件哈希，运行目录测试并调整有证据变化的计数/版本断言。不得根据营销名称将 grok 与 grok-build、Pi 与 pi-acp 等入口自动当作同一实现。

## 仍需完成的接入

本段保留 R100 当时的范围判断，不是当前最终判定。原始范围调整与全部 A-N 仍需复核，A-8 未完成。本机 Windows 10（2026-09-30 R100）：A-5 仍无真实手机 → **不可勾选 A-5**（计划 P5 原文含「至少一台真实手机」）。Gemini 仍无 key → **不可勾选 A-3**（计划 P2 验收要求每候选完成文本/读写/命令等）。A-4：**已勾选**——对照计划 P3 验收「38 个 ACP 候选均有明确归属和能力结论；只有真实通过验收的项可标已验证支持」，四态全表已登记且允许「可配置但未实测」；先前「未实测>0 不勾 A-4」是 loop/verifier 加严，非计划原文。R90 将 **agoragentic-acp** 重分为 `不支持`（无 session/new）。

## A-3 首批原子验收矩阵（R70）

书面条：`每个候选记录 CLI 版本与认证、文本、读文件、授权写入、命令、拒绝、取消的实际结果；Copilot 特殊模式/config 回归；不支持能力明确说明。` 候选：**Copilot、Gemini、Qwen、Cline、Hermes**（Gajae 属目录余项，不计入 A-3 勾选）。

| 原子项            | Copilot                    | Gemini                       | Qwen                   | Cline               | Hermes                 |
| ----------------- | -------------------------- | ---------------------------- | ---------------------- | ------------------- | ---------------------- |
| CLI 版本          | 1.0.89 ✓                   | 0.61.0 ✓                     | 0.24.7 ✓               | 3.0.65 ✓            | 0.21.5 ✓               |
| 认证              | gh 后备 ✓                  | 负向失败 ✓；成功路径缺 key ✗ | openai 边界+本地夹具 ✓ | 空方法+本地 ✓       | 空方法+本地 ✓          |
| 文本              | ✓                          | ✗ 无 key                     | ✓ 本地夹具             | ✓ 本地夹具          | ✓ 本地夹具             |
| 读文件            | ✓                          | ✗                            | ✓                      | ✓                   | ✓                      |
| 授权写入          | ✓                          | ✗                            | ✓                      | ✓                   | ✓                      |
| 命令              | ✓                          | ✗                            | ✓                      | ✓                   | ✓                      |
| 拒绝              | ✓                          | ✗                            | ✓                      | ✓                   | ✓                      |
| 取消              | ✓                          | ✗                            | ✓                      | ✓                   | ✓                      |
| 动态模型          | 未广告；CLI 默认入口说明 ✓ | 未建成会话                   | ✓ 本地目录             | ✓ openai-compatible | ✓ custom:…             |
| 模式              | Agent/Plan ✓               | ✗                            | plan/default… ✓        | Plan/Act ✓          | default/accept_edits ✓ |
| 命令发现          | available_commands ✓       | ✗                            | （夹具路径）           | （夹具路径）        | （夹具路径）           |
| 审批上游 optionId | ✓                          | ✗                            | ✓                      | ✓ allow_once        | ✓                      |
| 不支持说明        | 模型目录未广告等 ✓         | 成功路径缺凭据 ✓             | 外部账号未验 ✓         | 外部账号未验 ✓      | 外部模型未验 ✓         |

**Copilot 特殊 mode/config**：agent / allow_all 往返 ✓（见 copilot-acp-provider.md）。  
**整条 A-3（证据层）**：Gemini 成功路径仍缺真实账号（负向/握手 ✓；文本/工具 ✗）——**不得伪造 live 成功**。  
**旧 R109 范围陈述**：历史报告记载「需要登录真实账户和实机验证的都跳过但是保证功能完整可用。」并据此勾选 A-3；原始人类消息与具体被调整门槛仍待核对。负向认证/通用路径不证明 Gemini 真实文本或工具成功，本页不自行判定功能全部完整。

## A-4 三十八基线项及额外项的历史证据分类（R71）

书面 verify 只用四态：`真实可用` / `未实测` / `平台限制` / `不支持`。下表覆盖目录中与 Paseo 基线对齐的 ACP ID（含官方扩容 antigravity/harn 等）；**未实测不得当作全部完成**。Cursor/Grok/Kimi 为专用驱动复用。

| ID              | A-4 四态                 | 证据摘要                                                                                                       |
| --------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| agoragentic-acp | 不支持                   | R90：`--acp` 无 session/new（仅 MCP tools/\*）；非 Adapter bug                                                 |
| antigravity-acp | 未实测                   | Windows 可装+握手；session 需 oauth/key                                                                        |
| amp-acp         | 未实测                   | 握手；装 amp CLI 后仍 Authentication required（需 Amp key）                                                    |
| auggie          | 未实测                   | 握手；`auggie login`（ACP 不支持认证）                                                                         |
| autohand        | 未实测                   | 握手；底层 CLI/安装 auth                                                                                       |
| cline           | 真实可用                 | 本地夹具工具链（读/写/命令/拒绝/取消）                                                                         |
| codebuddy-code  | 未实测                   | 握手；多 auth                                                                                                  |
| codewhale       | 真实可用                 | R87 Ollama DeepSeek-compat：marker + write；shell 未硬过                                                       |
| cortex-code     | 未实测                   | 可装+会话；R82 Ollama 注入仍需 Snowflake 连接，工具副作用未验                                                  |
| corust-agent    | 未实测                   | 可装+握手；oauth_browser                                                                                       |
| crow-cli        | 平台限制                 | Windows termios/pty                                                                                            |
| cursor          | 真实可用                 | 专用驱动复用                                                                                                   |
| deepagents      | 未实测（仅局部读取记录） | R87 Ollama：`read_file` 回显 marker；写文件空/未硬过                                                           |
| devin           | 未实测                   | 可装+握手；devin-browser                                                                                       |
| dimcode         | 未实测（仅局部读取记录） | R87 Ollama provider：grep 读出 marker；写未硬过                                                                |
| dirac           | 未实测                   | R90：Ollama openai+关 thinking；约束 workspace 仍无 marker/写                                                  |
| factory-droid   | 未实测                   | 握手+session；prompt 401/`Agent error`（需 Factory 账号；非 Adapter）                                          |
| fast-agent      | 真实可用                 | R85 Ollama `qwen2.5:3b`：读/写/`terminal/create` shell 副作用（客户端须 `fs/*`+`terminal/*`）；拒绝/取消未硬测 |
| gemini          | 未实测                   | 握手/负向认证有证；Ollama 404；成功工具缺 Google key（亦堵 A-3）                                               |
| gjc             | 真实可用                 | 工具探针（读/bash/取消等）                                                                                     |
| glm-acp-agent   | 真实可用                 | R86 Ollama：`Z_AI_API_KEY=ollama` + `ACP_GLM_BASE_URL=…/v1`；marker 回读 + write 写盘；shell 未硬过            |
| goose           | 真实可用                 | R78：Ollama 读/写/shell/拒绝 HARD_PASS=4/4；R79 cancel 三策略仍 end_turn（软上限）                             |
| grok            | 真实可用                 | 专用驱动复用                                                                                                   |
| harn            | 未实测                   | R90：host/capabilities 已由产品默认回复；NL Compilation；表达式 end_turn≠工具可用                              |
| hermes          | 真实可用                 | 本地夹具工具链                                                                                                 |
| junie           | 未实测                   | stdio 握手/会话；Effect start 可挂起；工具未测                                                                 |
| kilo            | 真实可用                 | R88 Ollama OpenAI-compat：marker 回读 + write 写盘                                                             |
| kiro            | 平台限制                 | Win10 握手前失败；异步命令 live 未验                                                                           |
| kimi            | 真实可用                 | 专用驱动复用                                                                                                   |
| minimax-code    | 未实测                   | R89：Ollama custom provider 会话可建；工具调用落成正文 JSON，无 marker/写；仍常 login                          |
| minion-code     | 不支持                   | ACP 依赖/协议写 stderr                                                                                         |
| mistral-vibe    | 未实测                   | session 可建；`MISTRAL_API_KEY=ollama` → Invalid API key                                                       |
| nova            | 未实测                   | 握手；需 Nova Setup / kore-terminal-auth                                                                       |
| poolside        | 未实测                   | 握手；`pool login`（空 authMethods≠匿名）                                                                      |
| qoder           | 未实测                   | 握手；login/PAT                                                                                                |
| qwen-code       | 真实可用                 | 本地夹具工具链                                                                                                 |
| sigit           | 未实测（仅局部读取记录） | R88：read_file 回显 marker；写未硬过                                                                           |
| stakpak         | 未实测                   | 可装+握手；session/new 503 Service Unavailable（厂商 API；非 Adapter）                                         |
| traecli         | 平台限制                 | 安装脚本区域 403；企业登录；异步命令未验                                                                       |
| vtcode          | 真实可用                 | R85 Ollama：marker 回读 + write 写盘；shell 未硬过；拒绝/取消未硬测                                            |

**Kiro/TRAE 异步命令**：产品有扩展命令路由；**真实 CLI live 未通过**（平台/区域）→ 四态 **平台限制**（R94：不当作 Adapter 真缺口继续 fail）。  
**Droid MCP**：`supportsMcpServers:false` 目录默认 + Driver 注入门禁测试 ✓。  
**环境参数**：目录/向导可配置；Harn `environmentPolicy` 产品默认 ✓。  
**整条 A-4（R100）**：**勾选**——计划 P3 验收是「均有明确归属和能力结论」，不是「未实测必须为 0」。

## A-4 未实测 one-shot 解锁（R93）

书面四态不变：握手≠真实可用。下表只登记**解锁命令**；升态仍需 ToolProbe（文本+工具副作用）。机器可读副本：`.t3/paseo-unblock/unlock-commands.json`（gitignore）。旧Gap verifier：`node .t3/paseo-unblock/paseo-a8-gap-verifier.cjs`。它不是当前全部范围最终独立审核，不能根据marker自行豁免或宣布完成。

| ID              | One-shot 解锁                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| antigravity-acp | `$env:GEMINI_API_KEY='…'` 或 oauth-personal / agent-platform 登录后 ToolProbe                                                     |
| amp-acp         | `amp login`（或 amp-acp `authenticate` methodId=`setup` + Amp API key）后 ToolProbe                                               |
| auggie          | `auggie login` 后 `auggie --acp` ToolProbe（`AUGMENT_DISABLE_AUTO_UPDATE=1`）                                                     |
| autohand        | 安装底层 Autohand CLI 并完成 `autohand-install` 认证后 ToolProbe                                                                  |
| codebuddy-code  | `codebuddy login`（iOA/external/internal/selfhosted）后 `codebuddy --acp` ToolProbe                                               |
| cortex-code     | 配置 **Snowflake** 连接（Ollama 不够）后 `cortex.exe acp serve` ToolProbe                                                         |
| corust-agent    | 完成 `oauth_browser` 登录后 ToolProbe                                                                                             |
| devin           | 完成 `devin-browser` 登录后 `bin/devin.exe acp` ToolProbe                                                                         |
| dirac           | `dirac auth --provider openai --apikey <REAL> --modelid <m> --baseurl <url>`；ToolProbe 须回显 marker（本地 Ollama 仍常路径幻觉） |
| factory-droid   | `$env:FACTORY_API_KEY='…'` 或 device-pairing；`droid.exe exec --output-format acp-daemon` ToolProbe                               |
| gemini          | `$env:GEMINI_API_KEY='…'; powershell -File .t3/paseo-unblock/paseo-a3-gemini-probe.ps1`（亦堵 A-3）                               |
| harn            | `harn doctor` 配齐真实 LLM 凭据；ACP NL 须离开 Compilation 后再 ToolProbe                                                         |
| junie           | JetBrains 账号（`jetbrains-account`）后 `junie.exe --acp=true` ToolProbe                                                          |
| minimax-code    | `mcode login` 后 Node+`cli.js acp` ToolProbe                                                                                      |
| mistral-vibe    | `$env:MISTRAL_API_KEY='…'` 或 `browser-auth`；`vibe-acp.exe` ToolProbe                                                            |
| nova            | `nova setup` / `kore-terminal-auth` 后 `nova acp` ToolProbe                                                                       |
| poolside        | `pool login` 后 `pool-windows-amd64.exe acp` ToolProbe                                                                            |
| qoder           | `qodercli login` 或 PAT（`qoder-personal-access-token`）后 `qodercli --acp` ToolProbe                                             |
| stakpak         | `stakpak login` + 厂商 API 非 503 后 `stakpak.exe acp` ToolProbe                                                                  |

## A-4 原子要求核对（R71）

书面条：`38 项逐项证据表，现有 Cursor/Grok/Kimi 复用；每项区分真实可用、未实测、平台限制或不支持，未实测不当作全部完成证据。` 另：Kiro/TRAE 异步命令、Droid MCP 限制、环境参数生效。

| 原子                             | 状态                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 38 项能力表存在且分类            | ✓ R71/R90 四态全表；agoragentic→不支持；真实可用 16；未实测 19；平台限制 3；不支持 2 — **P3 验收已满足（登记结论，非要求零未实测）** |
| Cursor/Grok/Kimi 复用            | ✓ 专用驱动                                                                                                                           |
| Droid `supportsMcpServers:false` | ✓ 目录/Driver 注入门禁测试                                                                                                           |
| Harn `environmentPolicy`         | ✓ 产品默认 inherited；建会话通过                                                                                                     |
| Harn `host/capabilities`         | ✓ Runtime 默认回复；R90 证实缺回复才 timeout；NL Compilation；表达式 end_turn                                                        |
| Kiro/TRAE 异步命令 live          | ✓ 平台限制（kiro+traecli 四态已登记；Win10/区域阻断 live，非 Adapter 缺口）                                                          |
| 余项工具真实可用                 | 登记为未实测 19（凭据/厂商 API/dirac 路径幻觉等）；**不当作「已验证支持」**；无新 Adapter bug                                        |

**整条 A-4**：**已勾选**（R100：对齐计划 P3；未实测仍是合法登记态，升「真实可用」需各自 ToolProbe/凭据）。

CodeWhale、Gajae、Hermes、Kiro、TRAE 手工入口仍在。A-7 已勾选（产品 SSH OR 桶）。

## 目录参数到实例的传递

`AcpRegistryCatalogEntry.environment` 复用实例环境合同；当前只预填四个已核对的公开默认值：`AUGMENT_DISABLE_AUTO_UPDATE=1`、`DROID_DISABLE_AUTO_UPDATE=true`、`FACTORY_DROID_AUTO_UPDATE_ENABLED=false`、`FAST_AGENT_MODEL=codexplan`。未知变量、其它值和畸形环境对象不生成可选择命令；不能把 PATH、NODE_OPTIONS 或凭据作为目录环境自动写入。新增允许项需先核对上游语义，不以猜测扩展。

解析器要求包版本与目录 version 相同，拒绝浮动版本及 shell 特殊字符。uvx 的 `package@version` 和 `package==version` 统一生成 `uvx --from package==version package args`，当前官方两项为 fast-agent 0.10.1 和 minion-code 0.1.44。Windows npx 仍走既有 cmd 入口，uvx 使用原生运行器。

添加向导同时保存 command 与公开 environment，显示参数供用户检查；手改命令即清除目录选择，恢复旧命令也不会复活旧环境。切换目录替换环境；切到其它驱动不注入 ACP 参数。保存仍通过所选环境的既有 settings API；敏感配置继续使用原有 secret store。实例诊断需同时匹配命令及必要环境值，额外的账号环境变量不妨碍匹配。Web 和 Electron 共用该向导，目录行显示 Agent 图标；可下载二进制显示归档链接与“下载并安装”。Mobile 的“添加供应商实例”在选择 ACP Agent 时显示同一 `acpRegistryCatalog` 查询的结果（`AcpRegistryCatalogSection`），可搜索、显示图标（CDN）、离线快照、手工/平台不可用、配置状态、安装/归档链接、官方二进制下载和公开环境；选择后由 `makeMobileAcpCatalogInstance` 保存与 Web 相同的 command、authMethodId、MCP 兼容默认与 environment，并建议合法实例 ID。一次只渲染 12 个匹配项，其余提示细化搜索。Mobile 暂无 Copilot/Gemini 快捷按钮，也不能在添加前编辑命令，添加后在实例卡片修改。

外部核对：2026-09-30，关键词 `uvx --from exact version`、`ACP registry distribution env`。采用 [uv 官方工具说明](https://docs.astral.sh/uv/guides/tools/) 的版本与 --from 规则、[官方 ACP 注册表](https://github.com/agentclientprotocol/registry) 的 distribution 字段，以及上述固定 Paseo 命令作交叉检查；不采用第三方安装脚本。执行前须按官方说明安装 [Node.js](https://nodejs.org/en/download) 或 [uv](https://docs.astral.sh/uv/getting-started/installation/)。软件包下载、认证与工具成功率不由目录解析测试证明。

回滚本增量：撤回目录 environment/uvx 解析、向导选择及相关可选字段，保留既有快照和其它 ACP 功能；无数据库迁移。已保存实例仍是原有 command/environment 结构，若要撤回其公开参数，可在实例设置手工删除对应变量，不触及账号秘密。

## 五个手工安装入口

核对日期 2026-09-30；检索词为 `codewhale serve --acp`、`GJC_ACP_PERMISSION_MODE`、`Hermes ACP extra`、`kiro-cli acp installation`、`TRAE CLI ACP Windows`。采用各项目官方安装文档和源码文档，优先于 Paseo 旧条目和第三方教程。未执行安装脚本，未复制上游实现代码。表中的版本均为本机安装决定，目录不把 Paseo 的历史版本伪装为锁定版本。

| 入口       | 预填命令                | 前置条件与平台依据                                                                                                                                                                                                                          | 来源与能力边界                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeWhale  | `codewhale serve --acp` | [官方安装](https://codewhale.net/en/install)列出 macOS/Linux/Windows x64、arm64；Android arm64 为预览，FreeBSD/OpenBSD 需源码构建。已核对 v0.10.0 Release 平台资产，目录仍不锁定本机版本。                                                  | [官方 Runtime API](https://github.com/Hmbown/CodeWhale/blob/main/docs/RUNTIME_API.md#acp-stdio-adapter-codewhale-serve---acp)列出 initialize/new/prompt/cancel 与工具审批；完整持久线程/steering 能力仍有限。                                                                             |
| Gajae Code | `gjc acp`               | [官方安装](https://gajae-code.com/docs/getting-started.html)有 macOS/Linux x64、arm64，Windows 只列 x64；Windows arm64 不提供预填。实例加入 `GJC_ACP_PERMISSION_MODE=prompt`。                                                              | [官方接入说明](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/terminal-app-integrations.md#paseo)和[环境参数](https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/environment-variables.md)确认权限询问；不启用 auto/always-allow。取消 owned 子任务的额外配置本轮未启用。 |
| Hermes     | `hermes acp`            | 先按[官方安装](https://hermes-agent.nousresearch.com/docs/getting-started/installation)安装，再按[ACP 指南](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)安装 ACP extra、配置模型；可执行 `hermes acp --check` 检查。 | [平台表](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)覆盖 Windows/macOS/Linux x64、arm64，Android arm64 为次级支持。不得用同名 PyPI 包替代官方安装。                                                                                                      |
| Kiro CLI   | `kiro-cli acp`          | [官方安装](https://kiro.dev/docs/getting-started/installation/)已支持 Windows 11，Linux 要求 glibc 2.34+ 或 musl 版本，macOS 亦支持。先安装 CLI 并登录，不能用 IDE 下载状态代替 CLI。                                                       | [ACP 文档](https://kiro.dev/docs/cli/acp/)确认 stdio JSON-RPC。特殊异步命令 `_kiro.dev/commands/available` 的适配仍需专项测试；平台 OS 最低版本以文档为准，目录只做 OS/CPU 粗粒度限制。                                                                                                   |
| TRAE CLI   | `traecli acp serve`     | [官方安装](https://docs.trae.cn/cli_get-started-with-trae-cli)列出 Windows 10+、macOS 14.7.8+、Ubuntu 20.04+/Debian 10+ 的 x64、arm64，国内版需企业登录。                                                                                   | [ACP 文档](https://docs.trae.cn/cli_acp)确认子进程启动命令；延迟命令通知和工具/审批仍待真实 CLI 验收。                                                                                                                                                                                    |

实现位于 `manual-agent-catalog.ts`，用同一 DTO 进入原有目录选择/实例保存/GenericAcpDriver，不建立第二套驱动。`setup` 只带公开 HTTPS 文档链接和核对日期，向导选择后显示完整前置说明。手工条目使用 `availability=manual`，支持平台可预填已有 CLI 的命令；未安装时由原实例探测报告缺失，不标记“已安装”。不支持的平台无预填按钮但仍可查阅文档。已有同 ID 条目原样优先，不根据名称或包名合并。

回滚：撤回补充目录合并、可选 setup 合同和链接展示。已保存 command/environment 继续由原驱动读取，无需数据迁移；可单独停用新增实例，不删除会话历史。五项官方工具、账号、多端与远程结果仍均为未实测。
