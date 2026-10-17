// Node 无法加载真实的单图标模块：它们 import react-native-svg，而后者深入
// react-native 的 Flow 语法入口。测试只断言元素身份与 props，从不渲染图标
// 输出，所以每个图标名解析到独立的 stub 模块实例即可（vite.config.ts 的
// alias 以 ?icon=<name> 区分实例）。
export const iconName = new URL(import.meta.url).searchParams.get("icon") ?? "unknown";

export default function TablerIconStub() {
  return null;
}
