import { createPackageVitestConfig } from "../../vitest.base";

export default createPackageVitestConfig(new URL("./", import.meta.url), {
  coverageThresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
});
