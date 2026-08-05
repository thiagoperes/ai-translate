import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageExclude: ["src/index.ts", "src/types.ts"],
  coverageThresholds: {
    branches: 65,
    functions: 80,
    lines: 74,
    statements: 74,
  },
});
