import * as NodeURL from "node:url";

import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// 单图标入口（@tabler/icons-react-native/IconXxx）被 vitest 外置给 Node 原生
// 加载，而其内部 import react-native-svg → react-native（Flow 语法）会让 Node
// 直接抛 SyntaxError。这里把所有单图标入口重定向到按图标名分实例的 stub，
// 组件测试只依赖元素身份与 props，不依赖真实渲染输出。
const tablerIconStub = NodeURL.fileURLToPath(
  new URL("./src/test/tablerIconStub.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@tabler\/icons-react-native\/(.+)$/,
        replacement: `${tablerIconStub}?icon=$1`,
      },
    ],
  },
});
