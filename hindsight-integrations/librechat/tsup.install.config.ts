import { defineConfig } from "tsup";

// Installer CLI only: ESM, no dts, and crucially `clean: false` so it can be
// chained after the normal `tsup` build without wiping dist/.
export default defineConfig({
  entry: ["src/install.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: false,
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
