import { ja } from "../i18n/ja";
import { registerLanguageCatalog } from "../i18n/catalogs";

// 生产构建里日文词表是按需加载的 chunk；单测同步断言日文文案，
// 所以在每个测试文件导入前先登记一次，保持 `t()` 的同步语义。
//
// 只导入词表注册表（纯数据），不导入 runtime：runtime 会在模块初始化时
// 读取 localStorage，提前求值会让依赖「导入前替换 localStorage」的用例
// 拿到真实的 jsdom storage。
registerLanguageCatalog("ja", ja);
