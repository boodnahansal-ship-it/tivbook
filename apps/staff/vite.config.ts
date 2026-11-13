import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Same build runs in a browser and inside the Windows app (Electron loads it from disk, hence base "./").
export default defineConfig({ plugins: [react()], base: "./", envDir: "../..", server: { port: 5173, strictPort: true }, build: { outDir: "dist", chunkSizeWarningLimit: 1200 }, clearScreen: false });
