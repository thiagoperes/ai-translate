import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: { generator: "oxc", sourcemap: true, tsconfig: false },
  entry: ["src/index.ts", "src/bin.ts"],
  format: "esm",
  sourcemap: true,
  target: "node20",
});
