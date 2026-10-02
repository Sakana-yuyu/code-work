# ACP 二进制分发与哈希来源

服务端从 [ACP 官方目录](https://agentclientprotocol.com/get-started/registry)解析当前平台分发，客户端只提交目录ID，安装时再次读取目录。Web、桌面和Mobile共用此服务端入口；选择远程环境时归档保存在该环境。安装继续使用现有下载、SHA-256校验、解包与原子发布流程，不在客户端信任外部下载地址。

## 官方字段与维护者补充

厂商提供sha256时始终使用该字段。字段存在却非法（包括null、数字、空字符串或畸形哈希）时拒绝自动安装，不用维护者值掩盖错误。仅字段缺省时，按完整archive URL查询 [固定哈希表](../../apps/server/src/provider/acp/registry-binary-sha256-overlay.json)；未命中仍为手工安装。哈希来自已下载的固定官方归档字节，不是厂商签名或厂商承诺。

仍要求HTTPS、已支持的归档格式、当前OS/架构、相对启动路径与安全参数。查询参数、版本或URL变化均不匹配旧哈希；同版本URL的内容被替换时下载器返回checksum-mismatch，不解包、不发布。官方哈希与已保存哈希不同也不自动改回旧值，由下载校验判断。

已知7个归档的Windows x64哈希于2026-09-30计算、2026-10-01重新逐字节复核，覆盖Corust 0.6.0、Stakpak 0.3.88、VT Code 0.96.14、Antigravity ACP 1.2.1、Devin 3000.11.3、Cortex Code 1.0.73和Junie 3419.22。核对时官方目录中前6个URL仍相同；Junie已变为3419.24.0，其新URL不命中旧哈希，不因此获得自动安装能力。旧Junie归档的官方发布来源为 [3419.22发布页](https://github.com/JetBrains/junie-acp-release/releases/tag/3419.22)。不为其他平台或新版本推算哈希。

离线快照与在线响应都经过同一解析器，但合法在线结果始终优先，不用旧目录覆盖它。此哈希表不会向目录添加Agent，也不会修改在线版本/命令。本增量没有更新离线目录版本；快照的归档地址若不在已核对表中，仍需手工安装。

## 维护与验证

新归档须先核对官方目录/发布来源，在独立目录下载并计算完整字节SHA-256，再以精确URL加入表。记录获取/复核日期，变更须通过目录和下载器定向回归。不得把HTTP成功、文件名或同版本号当成哈希依据，也不得在查不到sha256时关闭校验。

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpRegistryCatalog.test.ts apps/server/src/provider/acp/AcpRegistryBinaryInstall.test.ts
```

目录回归覆盖缺省补充、官方优先、非法字段、URL变化、平台及命令安全和在线来源；下载器回归验证实际文件内容、校验失败、归档解包及并发发布。安装成功不能证明认证、文本、工具或账户余额可用；各项仍按 [入口验收合同](./acp-provider-validation.md)取证。

本次公开来源访问日期2026-10-01；检索词ACP Registry、Corust v0.6.0、Junie ACP 3419.22。采用官方目录与厂商发布页，因为它们直接定义分发地址；哈希以本地保存的归档字节重新计算，网页不是哈希证明。

无需数据库迁移。撤回本模块提交后，缺少厂商哈希的在线入口回到手工安装；已有安装目录和实例保留，不删除历史或覆盖用户配置。保留原下载器的校验与原子发布门禁。
