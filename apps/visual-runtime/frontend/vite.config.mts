import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "apps/visual-runtime/frontend",
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true
  }
});
