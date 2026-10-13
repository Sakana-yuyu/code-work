# Provider architecture

同一线程可在回合结束后切换 Provider 实例。切换时 `ProviderCommandReactor` 重新创建目标实例的会话，以已落库的线程消息构建限长历史交接，并排除当前及尚未执行的排队消息。交接还包含最近已完成工具调用的短结果摘要，标记为历史参考；没有结果的旧命令不会进入交接。消息与工具活动都按本轮请求的事件日志边界排除后续排队内容，整个交接不超过 64,000 字符。`ProviderService` 只在目标实例没有兼容续聊游标时将这段历史附在首次普通请求前；原生控制命令不消费交接历史。运行中的回合保持路由锁定。助手消息事件在生成时写入 `providerInstanceId`，内存、数据库与客户端都从事件读取归属，供同一时间线展示来源；旧消息缺少此字段时保持无来源标识。

消息投影保存首次 `thread.message-sent` 事件序号；同一时间戳的消息从数据库快照恢复时按该序号排序。迁移会从事件日志回填旧投影，流式更新继续保留首次序号，使重启前后的交接顺序一致。

## 供应商状态刷新

内置 driver 的快照均通过 `makeManagedServerProvider` 管理。同一实例且快照设置等价时，默认共享在途检查；设置不同则分别排队，实际检查仍由原 semaphore 串行执行。接入目录缓存的 driver 设置 `usesCatalogCache`，初次、设置变化及周期检查允许命中缓存，公开 `refresh` 强制目录更新。强制请求只加入已有强制检查，避免普通检查已读旧缓存后吞掉手动刷新；普通请求可加入任一同设置检查。当前 BYOK、Cursor、Grok、Kimi、Antigravity、Pi、OhMyPi、ZCode、通用 ACP、Codex、Claude、OpenCode 均接入；OpenCode 只合并在途目录，不保留已完成的连接状态。检查前后都核对设置，过期结果不发布；异步补充快照同时受设置和 generation 约束。这里的快照设置不代替 provider 配置：driver 的 `checkProvider` 仍捕获创建时配置，配置热更新由 registry 关闭旧 Scope、重建实例。

共享检查属于 provider Scope，调用者取消只结束自身等待。Scope 关闭时终止检查并唤醒全部等待者；失败清理登记后允许下一次刷新。短暂登记和退出清理不可中断，独立检查主体明确可中断，不继承父调用者的不可中断状态。完成结果以 `Deferred<Exit>` 共享，然后由各等待者重放，避免中断传播破坏共享唤醒。本机制不增加刷新缓存或统一超时，无等待者的检查仍会执行至完成或 Scope 关闭。

BYOK 的状态、保存配置发现及草稿发现统一调用 `ByokCatalog.fetchCatalog`。生产装配只构造一个服务，供 registry 中的 driver 与 WebSocket 服务共用；不含实例身份的目录结果在一分钟内共享，成功值容量为128，最近使用的结果优先保留。缓存键覆盖协议、实际地址、供应商模板、候选顺序、目录策略、凭据及自定义请求头；键仅用于索引，探测仍执行本次调用提供的原始配置。adapter/instance 标识与模型路由在缓存外补齐，不共享会话或可变快照。

每次 BYOK 共享目录加载拥有同一个 Scope 和 AbortController，全部候选、手工跳转及正文读取都在原有十五秒预算内。专用 `ByokHttpClient.fetchHttpClientLayer` 在构造时捕获实际 Fetch，执行时通过私有 Context.Reference 读取整轮信号；所有实际 fetch 接收同一对象，不向请求头或 RequestInit 写内部标记。仅在工厂构造时注入的 custom Fetch 保留，执行期上下文不能绕开包装。服务器仅为目录服务绑定该工厂，余额和其他HTTP服务沿用原传输。直接注入通用 HttpClient 的测试与扩展仍兼容，但不属于严格同对象 signal 的保证范围。

单个候选失败不会关闭整个目录 Scope；成功、全部失败、总超时或最后一个目录等待者离开时，统一 abort 并释放请求。某个等待者的短预算不缩短其他等待者的加载。不同目录目标分别拥有自己的共享加载和信号；实例跨通道检查的十五秒等待预算不能直接作为这些加载的取消所有者，否则会中断其他客户端。独立调用 `fetchByokCatalog` 仍建立自有 Scope。手工跳转保持原来的 `RequestInit { redirect: "manual" }` 边界，不从默认 options 回填认证头；跨源剥离、三次跳转限制和4 MiB正文限制继续生效。

Cursor 的无会话纯模型目录使用 `CliProviderCatalog.fetchCatalog` 的一分钟成功缓存、容量128及在途合并；完整检查由 `NativeProviderCatalog` 持有。Grok 无法从当前协议获得稳定认证身份，因此完整检查和模型目录仅共享在途执行，不复用完成值。每个 registry 创建目录对象，通过 `ProviderDriverCreateInput.catalog` 和 `nativeCatalog` 传入实例；同一 registry 的重建沿用它们，不同 registry 相互独立。直接创建 driver 时使用私有对象。版本、认证、检查时间、技能、实例自定义模型和身份保持实时；会话、adapter 和运行时状态保持实例独立。

CLI 目录身份散列实际命令、端点、工作目录与完整环境快照。Grok 完整检查键还包含技能实际 cwd、ACP 最终环境、配置准备路径/来源/网关及路由代次；直接调用传入的配置内容也参与身份。凭据与配置只参与摘要，不作为缓存键输出。目录加载使用本次调用的冻结参数与服务上下文，ACP 显式关闭环境二次继承；Windows 相对可执行文件和相对 PATH 条目锚定同一 cwd。Grok 路由协调在完整刷新预算内执行，个人默认配置目录只读；失败不复用旧路由目录，保留错误提示及自定义模型回退，没有增加 BYOK 的过期目录展示语义。

Cursor 的完整原生检查也使用注册表共享的 `NativeProviderCatalog`，about（含旧格式回退）、渠道配置读取与 ACP 模型发现共用十五秒工作预算和一个 controller。认证只合并在途检查；已观测版本、渠道及稳定账户身份加入纯目录键，认证 unknown、没有稳定邮箱或不能识别版本时重新发现目录。明确未登录时仍跳过 ACP。纯目录在当前 owner 中使用 `shareInFlight:false`，不另起预算或资源所有者；自定义模型与返回时的 checkedAt 分别按每个调用者的冻结配置补齐。

公开独立 `discoverCursorModelsViaAcp` 没有实时版本与账户证明，使用单独目录操作键，只合并等价在途探针，每次顺序调用重新发现。它与完整检查共用同一底层无会话 ACP 加载器。`withCatalogAbortSignal` 先检查预取消，安装并复查 abort 监听，在实际工作前让出调度以完成 race 登记；中断原样传播，结束移除监听。短命 about 和 Cursor 探针的局部 spawner 使用两秒强制退出宽限，其他 ACP 会话保持原策略；十五秒不包含所有操作系统清理耗时。Cursor 账号池凭据仍只在真实会话环境准备时解析，本次目录检查没有新增凭据刷新或借用 adapter。

Kimi、Antigravity、通用 ACP 的配置模型，以及 Pi/OhMyPi/ZCode 的路由模型，初始和健康检查入口也统一调用 `CliProviderCatalog.fetchCatalog`。纯配置加载没有外部进程，因此身份只含 driver、操作及实际影响模型结果的配置；不加入实例ID、命令、cwd、环境或认证。自定义模型复用展示层相同的规范化规则，去空、去重并排除内置重复项，保留顺序；路由快照只取 adapterId、displayName 和去除两端空格的 modelId。键与加载器共用快照，设置编辑不能污染已缓存结果。版本、安装、启用、认证和检查时间在缓存外计算；ZCode 官方凭据仍每次读取，Kimi 的 BYOK 发布前路由覆盖仍读取当前设置。目录缓存不共享 adapter、会话或实例运行状态，也不把会话内动态模式选项变成全局目录。

Codex 等价配置的整次原生刷新统一经过 `NativeProviderCatalog.fetchCatalog`，仅共享在途认证与健康结果；一次加载在同一个无会话 app-server client 中读取版本、`account/read`、模型分页与技能。十秒工作预算覆盖全部阶段与必要损坏诊断，诊断不能另外获得四秒；取消信号通过整段 Effect 与进程 Scope 中断停止 RPC 和后续请求。实际 binary、解析后的 argv、cwd、最终环境与 home 快照同时用于身份及执行；损坏诊断也使用相同 cwd/env。纯目录 `fetchCodexCatalog` 在当前 owner 中以 `shareInFlight:false` 读取或加载完成缓存，不建立第二个资源所有者；独立调用此公开目录接口仍可建立自己的探针 Scope。

Codex 纯目录身份仍含版本和协议可见账户。只有带非空邮箱的 ChatGPT 账户复用一分钟成功值；API Key、Bedrock、无账户及空邮箱不能由当前协议唯一识别，跳过完成值。此规则不等于完整认证指纹，同邮箱同套餐的组织切换仍可能在TTL内沿用目录。顺序健康检查继续读取当前账户，自定义模型与 checkedAt 在共享结果之外逐调用映射。冷检查和目录命中检查均只需一个健康进程，等价并发完整检查合并为一个进程；这一成本变化由协议及受控进程验收支持，不代表真实供应商端到端性能基准。

Claude 的 `fetchClaudeCatalog` 区分草稿 `configured-models` 与原生 `native-directory`。原生版本、SDK initialize 和技能扫描通过 `NativeProviderCatalog` 共用三十秒工作预算；这个上限保留慢 Bedrock 初始化的实际需要，阶段不会各自续期。SDK 接收 owner 的同一个 AbortController，Query 在初始化成功后继续存活至技能读取完成，最终再关闭；独立公开 capabilities probe 保留自有二十五秒约定。宿主与实例环境固定快照，Windows executable 和相对 PATH 按同一 cwd 解析。超时保留已确认的安装与版本及相应模型门控，认证显示 unknown。

Claude 当前账户与命令每次仍重新初始化读取，只缓存版本对应模型、命令与本地技能。整次刷新内部使用 `shareInFlight:false`，实例自定义模型在结果外分别合并；目录身份包含实际 executable、cwd、最终环境、版本及当次命令值，不缓存账户。初始化失败的降级目录不写缓存，不能覆盖或延长上一份成功值。成功初始化但账户字段全空保留此前状态语义，不将其当作已验证退出登录；明确认证失败覆盖初始化拒绝及随后恢复。关闭会话持久化、用户 hooks 和 MCP，只发送初始化控制消息，不发送用户 prompt。SDK `close(): void` 只能证明发起关闭，不能代表已等待 OS 进程完全退出。

OpenCode 的版本、模型、variants、agent 模式和技能统一经过 `OpenCodeCatalog.fetchCatalog`。每个 registry 创建独立目录对象，同一 registry 的实例和重建共用；直接创建 driver 时使用私有对象。本地身份包含 binary、cwd 和完整实际环境（含 BYOK 注入配置），远端只包含去除两端空格的 serverUrl、password 和 directory。键和执行使用同一份输入快照，自定义模型在结果外合并。当前最低版本的组合接口同时返回模型与 connected，后续检查必须重新读取，不能将它放入一分钟成功缓存；因此复用公共缓存的仅在途模式，完成即清除。外部 SDK 直接按配置构造客户端，不借用 adapter client、不启动本地服务器或创建 session。

OpenCode 每次共享加载拥有一个 Scope、AbortController 和十五秒工作预算。本地版本探测、三路目录命令及一秒重试等待均在此预算内；远端 provider、agent、skill 请求接收同一个 signal。后加入的等待者不会重置截止时间，首等待者取消不结束其余等待者的加载，最后等待者取消或超时则 abort 并释放资源。短命令使用两秒强制退出宽限并等待 finalizer，资源清理可能使实际返回晚于十五秒，不能把工作预算表述成绝对墙钟上限。公开 runtime 未传完整环境时继续继承宿主，目录内部固定最终 cwd/env 后关闭二次继承；Windows 命令解析与 spawn 使用同一参数。技能普通查询失败仍允许空列表，取消不会被降级为成功。

`NativeProviderCatalog` 属于注册表，实例重建沿用，同一注册表的 Codex/Claude/Cursor/Grok/Kimi/Antigravity/通用ACP/Pi/OhMyPi/ZCode 等价配置共享完整加载。认证只在途共享，后续检查重新读取。强刷新只加入已有强刷新；普通请求可加入已有强刷新或普通刷新。强通道中新建的执行始终携带强意图，避免选通道与登记之间结束造成语义回退。每个真正加载拥有独立 Scope 与 controller，晚加入者不重新获得预算，最后等待者退出中断实际加载。资源清理可能延长实际返回时间，工作预算不是包含所有系统调用的硬墙钟上限。

Grok 的 `fetchGrokCatalog` 把刷新期路由准备、版本、技能、客户端初始化和 `x.ai/models/list` 纳入同一十五秒 Scope/controller。版本和 ACP 使用宿主工作目录，技能使用服务器工作目录，两者的解析和执行均使用各自实际 cwd 与完整环境。owner 内技能不另设四秒超时，独立技能调用仍保留四秒最佳努力；普通技能失败返回空列表，中断继续传播。短命令和局部 ACP 探针设置两秒强制退出宽限，不修改会话默认策略。目录只握手与读取模型，不执行认证写入、session 或 prompt。

路由准备只读取一次设置，托管配置与模型覆盖使用该快照；覆盖函数没有异步尾读，也不共享首实例身份。注册表把已有的 `__byokSourceFingerprint` 在解码外作为可选 `catalogRevision` 传入 driver，仅是内存元数据。新代不加入旧代加载；未知认证顺序刷新每次读取 CLI。准备的预期错误经 `fetchCatalogWithError` 保留原 cause，由 Driver 补当前调用者的 `ServerSettingsError` 路径/操作/实例身份；managed 公开刷新沿用 defect 承载错误的既有契约。原 `fetchCatalog` 无错误签名和旧状态入口的前五参数保持兼容，真正缺陷与中断不会被包装成预期错误。

创建实例时的初始协调、managed 前后设置读取及操作系统清理不属于上述十五秒工作预算。各实例默认使用独立 home；目录缓存代次不承担文件事务隔离。第54主题的模拟 Driver、真实 Windows 假 CLI、有效旧版对照和资源证据见 [移植进度](./port-progress.md)。

第60主题为同一服务进程中的共享可写 Grok home 增加 Scope 排他占用，从读取/协调配置持有至完整目录加载及其清理结束，初始配置协调也使用同一占用。排队位于既有十五秒 owner 内，取消排队者不释放持有者，最后参与者退出即删除临时占用记录；不同 home 并行。路径按 realPath 或最近存在的父目录规范化，Windows 大小写和真实 junction 别名共用身份，CLI 的 GROK_HOME 也使用该规范路径。文件系统、路径及平台服务在创建时捕获，让初始化与后续刷新使用同一规则。指向个人 home 的别名也按个人目录处理，代理写入失败关闭。

此占用保护 Code Work 的配置协调与目录消费，不是跨服务器进程的文件锁，也不约束外部 CLI 或编辑器自行修改配置。

第61主题按用户选择进一步约束实例配置所有权：同一可写home的路由模式、BYOK来源和本地网关必须一致，否则在任何配置写入、令牌创建或CLI启动前返回可操作错误，提示独立GROK_HOME。非代理模式不比较未使用的来源/网关字段，显示名、颜色、启用状态与自定义模型不进入文件配置身份。等价实例按Scope引用计数共享所有权，最后实例关闭后移除记录；构造失败也由注册表关闭子Scope释放。移除占用实例后，之前不可用的实例在reconcile中重新尝试创建，错误不是单向状态。

采用实例所有权而非握手短锁的依据是Grok会热重载`[model.*]`配置；仅保证启动完成无法保护后续会话。2026-10-13读取官方固定提交`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`的 [ConfigReloader](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/config/reloader.rs)，模型配置变化会发送ModelsChanged。只依据其行为约束自主实现，不复制上游代码或引入新CLI参数。实例配置所有权不占用目录排他信号量，等价实例的长会话、续接、文本生成与目录刷新仍可同时存在；实际Windows假ACP组合见第61主题验收。

多实例默认独立目录保持不变。配置所有权只覆盖同一服务进程中的Code Work实例，外部进程的配置/账号修改、原生会话文件并发和供应商认证不属于此保证；等价共享也不是账号或会话文件隔离。

Kimi 完整 `fetchKimiProviderCatalog` 将路由读取、纯配置目录及版本探针纳入一个十五秒 owner，纯模型成功缓存继续由 `fetchKimiCatalog` 提供。版本探针的 Windows 解析和 spawn 共用实际 cwd/env，关闭二次继承，设置两秒退出宽限；禁用实例仍如实检查安装。整轮键包含规范化模型配置、实际命令/工作目录/环境与准备来源/代次，认证状态只在途共享。Driver 初始映射保留原行为，刷新时用本轮设置的纯函数覆盖模型；设置读取失败时模型为空，保持失败关闭，不在发布前异步尾读。实际 Driver 跨实例身份、重建代次、Windows 阻塞版本退出及旧版预算对照见 [移植进度](./port-progress.md) 第55主题。

Antigravity 的 `fetchAntigravityProviderCatalog` 也由同一个十五秒 owner 持有配置模型和版本探针，纯配置完成值保留既有缓存。整轮身份包含规范化模型、命令/启用状态与实际 cwd/env，解析器和 spawn 使用相同冻结输入，短命令设置两秒退出宽限。禁用实例仍检查实际安装，未知认证与实时版本不缓存；完成时间和实例身份分别补齐。此 driver 没有代理路由准备，不增加无用准备回调。规范配置跨实例合并、Windows 版本进程退出和旧入口无预算的行为对照见 [移植进度](./port-progress.md) 第56主题。

通用 ACP Driver 私有完整 `fetchCatalog` 在同一个八秒 owner 内读配置目录和版本命令，不再给版本阶段追加八秒。命令在创建时解析并复制，完整身份使用实际命令/参数、规范模型、启用状态与每轮实际 cwd/env；解析器和 spawn 使用相同冻结环境，短命令采用两秒退出宽限。配置完成值保留既有缓存，命令输出和未知认证只在途共享。各实例身份与完成时间在外部补齐；首实例Scope关闭不结束其他实例的目录，而公开调用者取消仅结束自身等待。未知 --version 参数仍允许实际ACP握手，包仓库故障仍是错误。目录不启动会话，真实会话/MCP/模型选择路径保留。证据见 [移植进度](./port-progress.md) 第57主题。

Pi/OhMyPi/ZCode 的完整 `fetchPifamilyRefreshCatalog` 持有刷新期路由、配置目录、版本及官方凭据的十五秒预算。纯 `fetchPifamilyProviderCatalog` 完成缓存保留，旧健康入口兼容；实际二进制/参数前缀、启用/内嵌标记、规范路由展示字段、真实 cwd/env 与准备路径/来源/代次决定整轮身份，显示名和实例ID在结果外补齐。受管 home 保留在环境键中，不能为共享省略它。禁用与内嵌版本探针跳过不变，官方账户每轮重读。凭据阶段超时保留已确认安装/版本/模型，认证 unknown；typed路由错误关闭模型但仍探测CLI，中断/缺陷不由 Driver 的宽泛捕获吞掉。

版本解析和 spawn 使用同一完整环境与 cwd，关闭二次继承并使用两秒退出宽限。旧部分环境调用先捕获宿主以保留系统变量；受管 Driver 明确 completeEnvironment，禁止重新带回已清洗的供应商变量。启动配置写入、文本生成构造、初始路由/凭据以及 managed 前后设置仍是生命周期边界，刷新预算不构成这些操作的硬墙钟保证。三类 Driver、实际 Windows CLI 和旧预算对照证据见 [移植进度](./port-progress.md) 第58主题。

`ProviderCatalogCache` 分开保存成功结果和在途加载，默认强制刷新跳过成功值但加入同键的在途加载；失败保留上一份成功结果，不延长其TTL。`shareInFlight:false` 让已有 owner 在当前 Scope 读写完成缓存；活动加载按代次保护写回，较新加载及仍受保护的强刷新不会被旧普通结果覆盖，强刷新失败也不恢复旧代写权限。所有活动加载结束后清除代次记录，容量只限制成功值。每轮在途请求按独立对象登记和清理，旧轮不能误删新轮；lookup 在开始前先让 Cache 安装等待者与取消处理，避免同步回执重入取消遗漏共享资源。首等待者取消不影响其余等待者，最后一个离开后中断加载；实际终止通过资源回执验收，不将取消等待者等同操作系统退出。

BYOK 每个目录加载最多十五秒，每次实例状态检查另有同一个十五秒截止时间，逐通道传入剩余等待预算；超时仍可读取同键旧值，预算耗尽后不启动新请求。用户已确认每次实际目录加载共享信号、实例共用十五秒等待预算的边界，保留部分重叠目录的在途复用。A/B 与 B/C 两实例可以共用 B；取消一实例不取消另一实例的 B 或后续 C，最后等待者退出才 abort 并释放请求和正文。成功目录仍可复用，取消后的下一轮创建新信号。专用 Fetch 工厂的真实本机 HTTP 连接关闭收据见第59主题，不以模拟 signal 状态代替传输释放。

`ByokCatalog.fetchCatalog` 在第一次异步等待前复制目标、候选数组及等待选项，让缓存键与执行始终使用同一输入。实例检查也先复制适配器列表与候选数组，后续配置编辑由下一轮刷新读取；发布的模型标识和展示名称使用当前检查的快照，`checkedAt` 记录完成时间。十二类 provider 的共享刷新已覆盖工作预算与资源边界；显式共享可写 home、会话内模型/模式和完整入口/客户端/连接矩阵仍需继续验收。

BYOK Driver 的完整刷新由 `fetchByokProviderCatalog` 统一发现模型和本地技能，复用注册表的 `NativeProviderCatalog` 在途所有者。十五秒预算同时覆盖模型等待与文件扫描，两者并行执行；初始化只发布配置快照，随后异步刷新技能，不因挂起的文件系统阻塞实例创建。整轮键只取启用、模型路由与展示字段、各实际目录身份和技能 cwd；实例名称与余额凭据不影响共享。完成的技能扫描不长期缓存，下一轮重新读取文件。

`checkByokProviderStatus` 保留兼容入口，并以可选的内部 `onModels` 回执保留每个目标已完成的模型；回执只更新完整刷新内部状态，不逐目标发布半轮客户端快照。整轮超时后返回配置模型、已完成目录和已完成技能，并说明超时；检查时间在调用者返回前更新。取消依然逐层释放等待者，各实际 HTTP 加载继续持有自己的共享信号，部分重叠目标仍可复用；不能把外层 controller 强制覆盖到各目录传输。真实本机 HTTP 及 Driver 初始化/关闭证据见 [移植进度](./port-progress.md) 第62主题。

> For maintainers. Using Code Work? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. Code Work supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with twelve entries (ten named runtimes, one generic ACP driver, and
one BYOK executor):

| Driver kind   | Driver source                                 |
| ------------- | --------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]             |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]           |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]           |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]               |
| `kimi`        | [`Drivers/KimiDriver.ts`][kimi]               |
| `antigravity` | [`Drivers/AntigravityDriver.ts`][antigravity] |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]       |
| `piAgent`     | [`Drivers/PifamilyDrivers.ts`][pifamily]      |
| `ompAgent`    | [`Drivers/PifamilyDrivers.ts`][pifamily]      |
| `zcodeAgent`  | [`Drivers/ZCodeDriver.ts`][zcode]             |
| `acpAgent`    | [`Drivers/GenericAcpDriver.ts`][genericacp]   |
| `byok`        | [`Drivers/ByokDriver.ts`][byok]               |

Pi and OhMyPi share a BYOK-only architecture — see [pi-family-providers.md](./pi-family-providers.md); ZCode follows the same BYOK-only shape with a per-turn stream-json transport — see [zcode-provider.md](./zcode-provider.md); the user-configured ACP entry is covered in [generic-acp-provider.md](./generic-acp-provider.md).

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## ACP 目录查询与会话准备

`AcpSessionRuntime.prepareClient()` 只完成客户端初始化和配置要求的认证，共享成功结果与正在进行的请求，不创建、加载或恢复会话。真正的 `start()` 复用这个准备结果，再执行原有 session 建立流程；准备失败或被中断后可以重试。已经完成握手但会话创建失败时，只重试会话建立。

Cursor 的模型目录先准备客户端，再调用 `cursor/list_available_models`；Grok 的目录使用不认证的客户端初始化与 `x.ai/models/list`，沿用官方目录流程。Grok 的真实会话仍采用既有认证与会话扩展；目录查询不会进入可能保存认证信息的 authenticate 路径。两者均保留动态模型及现有 reasoning 能力映射，不通过创建临时会话补救目录失败。

Grok 扩展的 JSON-RPC result 还包含一层 `result` / `error` 包装，error 优先；缺少或无效的模型状态会使目录查询失败，并提示升级支持该接口的 CLI。配置的自定义模型仍保留。该接口提供模型元数据，不能据此宣称已经发现全部会话 configOptions 或模式。

2026-10-13 以 `xai-org grok-build cli_models`、`grok models ACP` 检索官方源代码，采用固定 SHA `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`（1.0.45）的[目录客户端](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/cli_models.rs#L49-L93)、[目录 handler](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/handlers/models.rs#L8-L25)及[认证实现](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L679-L686)核对请求与副作用。公开1.0.0源码已有该扩展，但更早公开alpha采用不同合同；不推断全部旧版本可用。实现只移植协议行为，不复制上游源码。本机没有已安装Grok CLI的运行证据，验收范围见[移植记录](./port-progress.md)。

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

Antigravity 的 `agy -p --output-format stream-json` 逐行输出 `init`、`step_update`、`result`。
适配器在进程运行期间把 `agent_response.text_delta` 送入共用正文流，并把 `tool` 步骤的
`ACTIVE` / `DONE` 映射为同一工具项的进行中 / 完成事件；`tool_info.error` 映射为失败。
末尾 `result.response` 是完整结果，已有文本增量时不能再追加，否则会重复显示。
会话 ID 从顶层或内层的 `conversation_id` 保存，终态以 `result.status` 和进程退出码共同判断。
依据是 [Antigravity 官方 Headless 文档](https://antigravity.google/docs/cli/headless/)；
检索词为 `Antigravity CLI stream-json step_update tool_info result`，2026-09-25 查阅。
该文档直接给出了事件字段和终态枚举，优先于按字段名猜测递归解析。

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

Conversation rollback is fail-closed: an adapter must declare `threadRollback: true` only when it
restores the provider's real conversation context. Codex is currently the only built-in adapter that
does so. Before changing files, `CheckpointReactor` excludes active work in the same Git worktree and
captures a recovery checkpoint plus the original Git index. Provider rollback and the local history
commit cannot form one transaction, so failures keep the recovery references and require the caller
to verify provider context before retrying.

### 共用工具时间线

适配器把原生工具事件映射为带同一 `itemId` 的 `item.started`、`item.updated` 和 `item.completed`；
`ProviderRuntimeIngestion` 分别投影为 `tool.started`、`tool.updated` 和 `tool.completed`。网页与手机
工作日志在仅收到开始事件时就显示进行中工具，后续按回合与 `toolCallId` 归并到同一行，并以终态
覆盖状态、保留失败详情。适配器若能取得原生工具调用 ID，应在整个生命周期沿用该 ID；否则
客户端只能根据相邻事件的工具类型与标题尽力归并。
Cursor/Grok 的 ACP `tool_call` 首次状态通常映射为 `item.updated`（`inProgress`），其工作日志
同样立即可见；OpenCode 的 `pending` 会映射为 `item.started`。Codex、Claude、Cursor、Grok、
OpenCode、Antigravity、BYOK、Pi、Omp 的定向适配器测试均把实际生成的工具事件送过
`runtimeEventToActivities` 验证；失败详情在 `tool.completed` 保留。正文增量走运行时流，最终
消息由 ingestion 收敛，网页和手机分别用共用活动合同派生时间线。
ACP 的 `search`（本地查找）与 `fetch`（外部数据）目前都投影为 `web_search`；工具 `data.kind`
随活动保留，网页工作日志据此把 `search` 归为代码搜索、`fetch` 归为网络检索。手机工作日志
只统计通用“搜索”次数，不区分两者。

### BYOK 余额查询边界

余额缓存的适配器指纹覆盖协议、地址、供应商、余额档案、账号标识、API Key 和余额 Token，
以 SHA-256 保存摘要。相同长度的密钥轮换也必须使旧账号余额缓存失效；指纹和 RPC 结果
均不包含明文密钥。`unsupported_profile` 表示当前没有已接入的查询接口，HTTP 或载荷错误
仍归入查询失败，成功响应中的余额 `0` 保留为实际零值。

2026-09-25 检索 `SiliconFlow /user/info retired replacement account API` 后核对
[SiliconFlow 官方更新日志](https://docs.siliconflow.cn/docs/release-notes/overview)：
`/user/info` 于 2026-08-14 停用，新账号接口待另行公告。Code Work 的官方 SiliconFlow
模板因此标为无已核验余额接口，并在自动档案中阻止对官方 `.cn` 和 `.com` 域名做通用
计费探测；明确选择的中转档案仍按用户配置执行。官方一手公告优先于
[CC Switch 用量查询说明](https://github.com/farion1231/cc-switch-website/blob/main/public/docs/en/2-providers/2.5-usage-query.md)
中的旧供应商模板。该说明区分官方余额与第三方自定义查询，并要求用户主动启用第三方
模板；我们保留逐档案显式选择和按适配器查询的边界，不把一个供应商名称等同于余额接口。

2026-09-25 检索 `OpenRouter credits management key current API key limit_remaining` 并核对
[官方账户额度接口](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
与[当前 Key 信息接口](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)：
`GET /api/v1/credits` 需要管理密钥，返回账户 `total_credits` 与 `total_usage`；普通
推理 Key 可调用 `GET /api/v1/key`，其中 `limit_remaining` 是该 Key 的支出上限剩余，
不能当成账户余额。仅对精确的 `https://openrouter.ai` 官方主机使用这两个接口，管理
密钥优先；管理密钥查询失败时不回退到 Key 限额，以免把两种数据混为一谈。相似中转
域名的自动档案不发送管理密钥。采用官方权限和字段定义，优先于第三方模板只标记
“可查询”而不区分凭据和数值语义的做法。

2026-09-25 检索 `Moonshot API balance available_balance CC Switch`，参考
[CC Switch 的 Kimi API 余额脚本示例](https://github.com/farion1231/cc-switch/discussions/5544)
及 [CodexBar 的 Moonshot 查询说明](https://github.com/steipete/CodexBar/blob/main/docs/moonshot.md)：
`GET https://api.moonshot.cn/v1/users/me/balance` 使用推理 API Key，读取
`data.available_balance`；后者还列出 `.ai` 国际域名。Code Work 仅对精确的 `api.moonshot.cn` / `api.moonshot.ai`
主机启用相应区域的查询，零值保留，错误载荷不当作零值。此公开示例直接给出请求和
字段，优先于只写“支持余额”的目录标签。这里核验的是同类产品的公开实现，尚无
供应商一手接口文档或本项目真实账号实测，后续须用真实凭据
核验两区返回格式。供应商目录的 `fixed` / `token_plan` 仅用于已经有对应查询实现的
Moonshot、DeepSeek、OpenRouter、智谱、Novita；未接入的 Kimi Coding、MiniMax、
StepFun Step Plan、火山和 ZenMux 改标为 `none`。官方模板未接入时，自动查询直接返回
`unsupported_profile`，不再盲探通用中转计费路径；自定义中转和用户显式选择的
通用计费 / NewAPI 档案仍照常查询。手机端余额为零时允许再次刷新。

2026-09-25 检索 `StepFun API account balance GET /v1/accounts official` 后核对
[StepFun 国内官方账户接口](https://platform.stepfun.com/docs/zh/api-reference/accounts/get)
和[国际官方账户接口](https://platform.stepfun.ai/docs/en/api-reference/accounts/get)：两区均要求
Bearer API Key，响应 `object: "account"`、`balance`、`total_cash_balance`、
`total_voucher_balance`；`balance` 才是当前可用余额，不能把总充值或总赠额相加。
目录新增 `stepfun_api` / `stepfun_api_en`，分别使用 `/v1` 推理地址和对应区域的
`/v1/accounts` 余额地址；既有 `stepfun` / `stepfun_en` 保持 `/step_plan`，标签明确写
Step Plan，仍不显示尚未接入的套餐 Credits 用量。国内 CNY、国际 USD 标签来自对应
官方账户页面的货币展示，API 响应本身没有货币字段。只允许 HTTPS 且主机精确匹配
`api.stepfun.com` / `api.stepfun.ai`、推理路径位于 `/v1` 时使用账户接口。显式
`balanceProfile: "none"` 统一尊重“不查询”，旧通道若曾保存此值，要改选“自动”才会
使用后来加入的官方余额接口。官方接口文档比其他产品的模板标签更能确定请求和字段。

2026-09-25 检索 `Novita CLI account balance credit_balance /v3/user`，核对
[Novita 官方 CLI 请求实现](https://github.com/novitalabs/novita-cli/blob/main/novita_cli/core/client.py)、
[余额命令](https://github.com/novitalabs/novita-cli/blob/main/novita_cli/novita_cli.py)及
[单位换算](https://github.com/novitalabs/novita-cli/blob/main/novita_cli/utils/output.py)：
`NOVITA_API_KEY` 以 Bearer 形式请求 `GET https://api.novita.ai/v3/user`，读取顶层
`credit_balance`，其整数单位是 `0.0001 USD`。Code Work 仅在 HTTPS 主机精确为
`api.novita.ai` 时使用此接口，缺字段、非法整数和 HTTP 失败均显示查询失败，不沿用 CLI
输出里的缺字段默认 `0`，以免把未知值误报为零余额。这里有官方 CLI 源码依据，但尚无
本项目真实 Novita 账号实测；接口变更时应更新实现与预设状态。

网页/桌面与手机编辑 BYOK 适配器时，只有供应商 ID、协议、完整 Base URL 均保持一致，
才允许沿用服务端脱敏密钥标记；切换目标须重新输入 API Key，同时清除旧余额令牌、
自定义请求头和模型目录元数据。服务端发现模型会忽略跨出新 Base URL origin 的模板
目录，以及已知属于其他供应商的模板目录。单独显式配置的 `modelCatalogURL` 仍按原有
自定义路径处理。这样即使旧版本客户端曾保存残留的 `modelCatalogURLs`，当前查询也不会
把新通道 Key 发送到另一家供应商的模板目录。

多 Agent 共用时间线、供应商选择、余额语义与同类产品公开行为的对照见
[多 Agent 与供应商体验：公开产品对照](./agent-provider-product-comparison.md)。该页列出检索日期、
一手来源、已验证的本仓库实现和真实客户端性能验收的剩余边界。

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

### 会话错误与部分回复

`session.state.changed(error)` 表示运行中的会话已失败。接入层先把会话和当前回合标为错误，再冲刷该回合尚在缓冲的助手文字并结束已投影消息的流式状态，保留可读的部分回复。带有旧回合 ID 的状态事件不能覆盖新回合；仅 `runtime.error` 活动仍可能先于正式终态到达，不能据此提前清除正文缓存。重试以新的回合开始，历史失败记录仍可查看。

## Rollback (Paseo plan §8)

Aligned with the integration plan’s rollback rule: disable a new provider profile/instance without
deleting history; keep catalog/contract increments compatible with older `command` strings; revert
event-parsing or UI changes by commit; stop only PIDs this process started (never kill by name). See
[paseo-plan-s7-s8-audit.md](./paseo-plan-s7-s8-audit.md) for the R101 §7/§8 audit. Per-entry install
rollbacks live in `docs/internals/*-acp-provider.md` and [paseo-provider-catalog.md](./paseo-provider-catalog.md).

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[kimi]: ../../apps/server/src/provider/Drivers/KimiDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[pifamily]: ../../apps/server/src/provider/Drivers/PifamilyDrivers.ts
[zcode]: ../../apps/server/src/provider/Drivers/ZCodeDriver.ts
[genericacp]: ../../apps/server/src/provider/Drivers/GenericAcpDriver.ts
[byok]: ../../apps/server/src/provider/Drivers/ByokDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts

## 接入范围与验证方法

### 统一目录的刷新与模式边界

以下是当前十二类 driver 的目录合同。工作预算只在实际共享加载建立时开始，晚加入者不重新取得一份预算；资源退出与初始化外的设置协调保持前文说明的边界。模式不能通过创建草稿会话来补造：支持无会话目录方法的 provider 在同一入口发现；仅在真实会话中广告模式的 ACP provider 继续消费该会话回执。

| Driver      | 一次实际刷新工作预算                   | 模式来源与草稿边界                                                 | 主要定向证据                                                               |
| ----------- | -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Codex       | 10 秒                                  | 与模型/技能共用 `collaborationMode/list`，按广告展示；错误撤回控制 | `CodexProvider.catalog/refresh`、`CodexCollaborationModes`                 |
| Claude      | 30 秒                                  | 使用实际绑定的两态运行控制；SDK模型/命令/技能查询不发送用户消息    | `ClaudeProvider.catalog/refresh`                                           |
| Cursor      | 15 秒                                  | 无会话模型目录；原生ACP模式来自实际会话广告                        | `CursorProvider.refresh`、`CliProviderCatalog`                             |
| Grok        | 15 秒                                  | 路由准备、版本、技能和无会话模型目录；原生ACP模式来自实际会话      | `GrokDriver.catalog`、`GrokProvider.refresh`、`GrokHomeAccess`             |
| Kimi        | 15 秒                                  | 配置模型目录；原生ACP模式来自实际会话                              | `KimiDriver.catalog`、`KimiProvider.refresh`                               |
| Antigravity | 15 秒                                  | 配置模型目录；实际发送不绑定两态，明确不展示                       | `AntigravityDriver.catalog`、`AntigravityProvider.refresh`                 |
| 通用ACP     | 8 秒                                   | 配置模型与版本统一刷新；原生模式来自实际会话，不为草稿握手建会话   | `GenericAcpDriver.catalog`、`ConfiguredCliProvider.catalog`                |
| OpenCode    | 15 秒                                  | 同批模型、variants、agent模式和技能；远端目录不启动本地CLI         | `OpenCodeCatalog`、`opencodeRuntime.catalog`                               |
| Pi          | 15 秒                                  | 路由模型目录；实际RPC发送未绑定两态，明确不展示                    | `PifamilyDrivers.catalog`、`PifamilyProvider.catalog/refresh`              |
| OhMyPi      | 15 秒                                  | 路由模型目录；实际RPC发送未绑定两态，明确不展示                    | `PifamilyDrivers.catalog`、`PifamilyProvider.catalog/refresh`              |
| ZCode       | 15 秒                                  | 路由模型与账号检查；保留实际绑定的 `--mode plan` 控制              | `PifamilyDrivers.catalog`、`PifamilyProvider.catalog/refresh`              |
| BYOK        | 实例15秒；每个实际HTTP目录也受15秒预算 | 不提供两态；模型与本地技能共用实例刷新，不创建草稿会话             | `ByokProvider.catalog/refresh`、`ByokDriver.catalog`、`ByokCatalog.signal` |

完整刷新的认证结果仅共享在途执行，后续检查重新读账号。纯配置及具有稳定身份的成功目录按各入口既有规则复用完成缓存；未知身份不以旧认证结果替代当前查询。所有加载仍执行调用时冻结的配置，缓存键只作索引；取出后补实例身份、自定义模型等非共享字段。手动强刷新不加入已开始的普通检查，最后等待者退出才释放共享加载。BYOK保留部分重叠HTTP目标复用；Grok等价共享home仍按配置所有权约束。

当前提交的40文件361项目录/刷新/缓存与客户端消费联合回归通过，测试副本不含主工作区无关改动，363个相关源检查前后SHA一致。测试包含当前账号正反变化、迟到/强制刷新、共享信号及退出、剩余预算、缓存身份和无会话边界；这不是十二家外部服务、三端产品或公网网络的实际运行证据。Web和Android已有受控实际证据分别见第65—67主题，Electron及剩余入口/连接矩阵继续开放。命令清单和证据范围见 [移植进度](./port-progress.md) 第68主题。

### 手机队列发送时的目录校正

Mobile入队时的目录归一化不能代替实际派发时的检查：等待或断线期间，模型选项可能已改变。`resolveQueuedThreadSettings` 兼容原有两参数调用，第三个可选目录输入采用共享会话广告合并和既有模型选项归一化，保留消息/线程设置的继承规则、推理与运行权限。在线Codex旧模型没有模式描述时也清除未广告的原生模式；未知环境/离线输入仍保留原始意图，不借用其他实例的选项。

配置流为了重连展示会保留缓存，连接已恢复不保证新配置流快照已经到达。因此两个outbox派发入口在持久化确认后，通过新增的客户端 `serverEnvironment.readConfig` 包装调用既有 `server.getConfig`，按消息所属环境读取当前投影，再校正选项/规范模式。该RPC读取registry快照，不在客户端另做目录探测；不增加wire方法、字段或provider会话。等价读取按环境singleFlight，失败沿用队列失败处理，读取期间进入编辑则保留消息。仅已有线程按需读取本线程活动，新任务不创建线程详情订阅。

第69主题六文件71项、Mobile/共享客户端目标类型、五源fmt/lint和最终旧版直接失败对照通过。实际Android离线文件中的Plan，在default-only目录下恢复后由真实Windows受控进程接收为default；消息身份、Medium与受监督权限保留。新任务入口有派发集成断言，本轮实际设备回合属于已有线程；ACP URI由定向用例验证。历史探针的队列计数对账另随第19项继续，不宣称全部队列UI已验收。具体失败、包重载、原始回执与清理边界见 [移植进度](./port-progress.md) 第69主题。

第70主题补齐新任务的Android设备证据：新任务实际在离线时保存原生Plan及创建项目参数，所属环境刷新为default-only后自动创建线程并以default发送一次。原用户消息ID、Medium、approval-required和指定项目保持一致，完整默认回复可见，物理outbox为空。页面在联网后曾出现加载/重连提示，之后自动恢复；不能用本轮结果宣称没有重连延迟。入队文件的规范interactionMode仍为default、原生选项为plan，实际派发已按当前目录对齐；入队表示的一致性仍随第14/19项核对。未新增产品源码或协议，未验收外部账号、Electron、iOS或公网relay/tunnel，详见 [移植进度](./port-progress.md) 第70主题。

第71主题修复上述新任务表示：显示使用当前模型能力解析规范模式；在线创建和离线入队/待发任务编辑快照复用 `resolveModelInteractionSettings`，把已知目录中的原生模式和规范模式同时对齐，不再受旧版Plan开关单独覆盖。归一化复用已有模型菜单与共享provider解析器；在线Codex旧模型没有模式广告时清除历史原生选项，未知/离线无配置仍保留输入，不借用其他实例。七文件83项、Mobile目标类型及四源fmt/lint通过；Android在线和离线新任务均实际以Plan执行，规范/原生均plan、Medium和受监督权限保留。编辑入口沿用同一快照构建函数，本轮没有编辑设备实测；完整能力、入口与连接矩阵继续开放，见 [移植进度](./port-progress.md) 第71主题。

### 连续保存实例设置

Web/Desktop 的供应商卡片仍提交完整 `providerInstances` 映射，服务端保持替换语义。表单连续失焦可能从同一个旧渲染快照构造三个实例，直接并发发送会让后来的名称保存覆盖之前的 home 或程序路径。`providerInstanceEdits` 将卡片更新按所选环境串行提交，以验证过的 `server.updateSettings` 成功回执作为下一次基础，只重放相对卡片旧实例实际改变的字段。对象递归重放；删除键、数组、标量与 null 保持替换，未改字段保留最新值。等待中的设置推送按相对上一推送的变化合入，失败不推进回执、不自动重试，之后的编辑仍可执行。

每次渲染捕获所属环境的队列和已有写入入口，切换环境不会将旧回调改送到新环境。该队列只覆盖既有卡片更新入口，没有新增协议、目录探测、权限或服务端设置合并方式；添加、删除、重置仍走原入口。十二类 driver 共用此卡片规则，不改变其目录与运行绑定。第66主题的旧版直接失败、实际隔离 Web 连续编辑与目录刷新证据见 [移植进度](./port-progress.md)；Mobile 独立设置路径及最终多客户端并发矩阵继续验收，单客户端队列不能保证未收到推送的跨客户端同时写入无冲突。

### 当前实例的模式入口

`client-runtime/providerModels` 的 `canUseProviderInteractionModes` 只读取当前 `instanceId` 的声明及当前模型能力，不按 driver 借用默认实例。已提供 `acpMode` 的模型使用原生选项；OpenCode 的 `agent` 选项同样替代旧两态控件。Web 的 Add 菜单、斜杠与 Shift+Tab 共用判断，Mobile 的斜杠菜单使用同一共享函数。普通发送、编辑重发、计划续接与 Mobile outbox 通过 `resolveProviderInteractionMode` 清除明确不支持实例的旧 plan 参数；离线且没有实例快照时保留请求模式。

Antigravity 的 headless 参数和 Pi/OhMyPi 的 RPC 发送没有绑定 `interactionMode`，现在明确声明不展示两态控件。ZCode 将 plan 绑定到实际 `--mode plan`，继续声明支持。Claude 及其余 ACP Adapter 保留既有运行绑定；ACP 原生模式仍来自真实会话的配置/模式回执并在线程内合并，不为草稿新建会话。

Codex 的 `fetchCodexCatalog` 在同一个无会话 client 上并行读取 `model/list`、`skills/list` 和 `collaborationMode/list`，缓存身份同时覆盖三者，取消与整次十秒工作预算沿用原生刷新所有者。广告转换为 `codexCollaborationMode` 模型选项，保留原生名称、default/plan 标识及模型/推理预设说明，忽略未知、空和重复模式；不补造另一模式。用户明确选择的模型与推理仍优先，不因预设元数据改变。可选方法不支持或畸形时保留已成功模型和技能、撤回模式并提示更新/刷新，带告警的目录不进入完成缓存，同版本下一次刷新可恢复。

三端复用已有选项界面；Codex 旧两态控件撤回。共享发送归一化同步选项与规范 `interactionMode`，Adapter 只从绑定实例读取 default/plan 原生选项并传给既有 `turn/start` 协作模式字段，运行权限和审批不变。Web 原线程续接及新线程“实施计划”显式选择广告的 default；没有相应模式时拒绝，不沿用旧 plan。目录撤回会清除失效选项。旧客户端的两态发送字段仍兼容，目录刷新没有另建线程或会话。

第65主题实际 Web 验证发现：实施后留下的两态 default 草稿会压住重新选择的原生 Plan，导致规范模式已持久化为 plan、计划卡片存在而就绪入口未显示。ChatView 现在只订阅当前草稿模型选项并采用同一共享归一化函数派生界面模式，不订阅提示词正文，不通过 effect 回写草稿。相同线程和计划数据在加载修复后立即恢复就绪入口；原线程实施、新线程实施及受监督权限的实际 RPC/SQLite 证据见移植进度第65主题。

第67主题在兼容Android开发客户端实际验证同一目录广告：线程模型设置分别选择原生default/plan后发送，真实Windows受控进程的turn/start、只读投影模式及完成消息一致，Medium和受监督权限保留。该证据是本机原生客户端到受控CLI协议的联调；Mobile计划卡片/实施入口、Electron/iOS及外部供应商另行验收。对应包哈希、源字节、清理与原始回执见移植进度第67主题。

2026-10-14 检索 `Codex collaborationMode/list` 并读取官方 [模式目录协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/collaboration_mode.rs)、[ModeKind](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs) 及 [TUI 消费方式](https://github.com/openai/codex/blob/main/codex-rs/tui/src/collaboration_modes.rs)。采用原始协议确认空请求、可空预设、目前可执行的 default/plan 和可选发现边界；自主实现解码与测试，没有复制参考代码，也没有增加 TUI 的单请求超时。原生服务端会继续提供模式指令；Code Work 既有开发者指令、MCP 访问约束与运行权限保持原绑定。定向测试、实际 Windows 子进程与完整验收边界见 [移植进度](./port-progress.md) 第64主题。

官方协议要求按真实会话广告传递模式标识，配置选项语义由类别声明。2026-10-14 检索 `ACP session modes session new config options`，采用 [ACP Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes) 与 [Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options) 原始规范；本主题复用既有回执合并，仅修复消费入口，没有复制参考代码。实际 Web/Android、本机推理 fixture 和能力声明回归见 [移植进度](./port-progress.md) 第63主题。

固定6个内置及38个ACP入口的绑定、能力事实来源、工具/账号/多端证据边界和定向验证入口见 [Agent入口与验收合同](./acp-provider-validation.md)。目录数量和历史勾选不能替代逐项执行结果与最终独立验证。
