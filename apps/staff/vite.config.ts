import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Same build is used online (browser) and inside the Windows setup (Tauri).
export default defineConfig({ plugins: [react()], envDir: "../..", server: { port: 5173, strictPort: true }, build: { outDir: "dist", chunkSizeWarningLimit: 1200 }, clearScreen: false });
