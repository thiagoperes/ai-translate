import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: { oxc: true, sourcemap: true, tsconfig: false },
  entry: ["src/index.ts"],
  format: "esm",
  sourcemap: true,
  target: "node20",
});
