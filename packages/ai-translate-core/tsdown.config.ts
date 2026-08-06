import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: { oxc: true, sourcemap: true, tsconfig: false },
  entry: [
    "src/index.ts",
    "src/address.ts",
    "src/acceptance.ts",
    "src/audit.ts",
    "src/constraints.ts",
    "src/hash.ts",
    "src/json.ts",
    "src/message-format.ts",
    "src/plural.ts",
    "src/policies.ts",
    "src/reconcile.ts",
    "src/sync.ts",
    "src/tokens.ts",
    "src/types.ts",
  ],
  format: "esm",
  sourcemap: true,
  target: "node20",
});
