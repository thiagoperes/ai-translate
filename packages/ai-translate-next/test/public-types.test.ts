import { describe, expect, expectTypeOf, it } from "vitest";

import { detectSetups as detectPlatformSetups } from "@ai-translate/integrations";
import type { Integration as PlatformIntegration } from "@ai-translate/integrations";

import {
  builtinIntegrations,
  createDetectionContext,
  defineIntegration,
  detectSetups,
} from "../src/index";
import type {
  CatalogKind,
  CatalogPlan,
  detectProject,
  DetectedSetup,
  DetectOptions,
  Integration,
  IntegrationPlan,
  renderConfig,
} from "../src/index";

describe("Next.js public API compatibility", () => {
  it("keeps JSON properties and named formats available without narrowing", () => {
    expectTypeOf<CatalogKind>().toEqualTypeOf<"document-json" | "namespace-json">();
    expectTypeOf<CatalogPlan["rootDir"]>().toEqualTypeOf<string>();
    expectTypeOf<IntegrationPlan["catalog"]["rootDir"]>().toEqualTypeOf<string>();
    expectTypeOf<IntegrationPlan["messageFormat"]>().toEqualTypeOf<"i18next" | "icu" | "plain">();
    expectTypeOf<DetectedSetup["plan"]>().toEqualTypeOf<IntegrationPlan>();
    expectTypeOf<ReturnType<typeof detectProject>>().toEqualTypeOf<Promise<readonly DetectedSetup[]>>();
    expectTypeOf<ReturnType<typeof detectSetups>>().toEqualTypeOf<Promise<readonly DetectedSetup[]>>();
    expectTypeOf<ReturnType<Integration["detect"]>>().toEqualTypeOf<Promise<DetectedSetup | null>>();
    expectTypeOf<ReturnType<typeof defineIntegration>>().toEqualTypeOf<Integration>();
    expectTypeOf<DetectOptions["integrations"]>().toEqualTypeOf<readonly Integration[] | undefined>();
    expectTypeOf<Parameters<typeof renderConfig>[0]>().toEqualTypeOf<IntegrationPlan>();
  });

  it("preserves custom JSON detector results and composes them with platform adapters", async () => {
    const jsonIntegration = defineIntegration({
      detect: async () => ({
        confidence: 1,
        displayName: "Custom JSON",
        evidence: [],
        integrationId: "custom-json",
        plan: {
          catalog: { kind: "document-json", rootDir: "messages" },
          messageFormat: "icu",
          sourceLocale: "en",
          targetLocales: ["de"],
          warnings: [],
        },
      }),
      displayName: "Custom JSON",
      id: "custom-json",
    });
    const adapterIntegration: PlatformIntegration = {
      detect: async () => ({
        confidence: 0.8,
        displayName: "Custom platform",
        evidence: [],
        integrationId: "custom-platform",
        plan: {
          catalog: { factory: { from: "@acme/platform", name: "createCatalog" }, kind: "adapter", options: {} },
          messageFormat: "plain",
          sourceLocale: "en",
          targetLocales: ["de"],
          warnings: [],
        },
      }),
      displayName: "Custom platform",
      id: "custom-platform",
    };
    const context = createDetectionContext(process.cwd());
    const jsonSetups = await detectSetups(context, { integrations: [jsonIntegration] });

    // These historical consumer accesses are also checked by `tsc`.
    const roots: string[] = jsonSetups.map((setup) => setup.plan.catalog.rootDir);
    const formats: string[] = jsonSetups.map((setup) => setup.plan.messageFormat);
    expect(roots).toEqual(["messages"]);
    expect(formats).toEqual(["icu"]);
    expect((await detectPlatformSetups(context, {
      integrations: [jsonIntegration, adapterIntegration, ...builtinIntegrations],
    })).map((setup) => setup.integrationId)).toEqual(["custom-json", "custom-platform"]);
  });
});
