import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageExclude: ["src/index.ts"],
  coverageThresholds: {
    branches: 55,
    functions: 90,
    lines: 75,
    statements: 75,
  },
});
