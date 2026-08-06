import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageThresholds: {
    branches: 80,
    functions: 90,
    lines: 90,
    statements: 90,
  },
});
