import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageThresholds: {
    branches: 68,
    functions: 80,
    lines: 80,
    statements: 80,
  },
});
