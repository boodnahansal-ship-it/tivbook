// Builds TiVBook-Staff-Setup.exe (one-click Windows installer).
// Run from apps/staff:  npm run setup:windows
// Packages from a clean staging folder: the app is fully bundled, so it needs no node_modules.
import { build } from "electron-builder";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const stage = join(root, "release", "stage");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const electronVersion = JSON.parse(readFileSync(join(root, "..", "..", "node_modules", "electron", "package.json"), "utf8")).version;

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(here, join(stage, "desktop"), { recursive: true, filter: (p) => !p.endsWith("build-windows.mjs") });
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: "tivbook-staff", productName: "TiVBook Staff", version: pkg.version, description: pkg.description, author: pkg.author, main: "desktop/main.cjs",
}, null, 2));

await build({
  projectDir: stage,
  targets: (await import("electron-builder")).Platform.WINDOWS.createTarget("nsis", (await import("electron-builder")).Arch.x64),
  publish: "never",
  config: {
    ...pkg.build,
    electronVersion,
    npmRebuild: false,
    publish: [],
    directories: { output: join(root, "release") },
    files: ["dist/**", "desktop/**", "package.json"],
  },
});
rmSync(stage, { recursive: true, force: true });
console.log("\n✓ release/TiVBook-Staff-Setup.exe");
