import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: { oxc: true, sourcemap: true, tsconfig: false },
  entry: [
    "src/index.ts",
    "src/bundle-json.ts",
    "src/document-json.ts",
    "src/durable-transaction.ts",
    "src/namespace-json.ts",
    "src/sharded-state.ts",
    "src/state.ts",
  ],
  format: "esm",
  sourcemap: true,
  target: "node20",
});
