import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageThresholds: { branches: 90, functions: 95, lines: 95, statements: 95 },
});
