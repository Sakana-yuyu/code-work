import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.ELECTRON_RENDERER_PORT ?? 5173),
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
