import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 14px 38px -18px rgba(15, 23, 42, 0.35)"
      }
    }
  },
  plugins: []
} satisfies Config;
