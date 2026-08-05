import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageThresholds: {
    branches: 60,
    functions: 90,
    lines: 80,
    statements: 80,
  },
});
