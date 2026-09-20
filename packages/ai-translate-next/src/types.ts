import { defineIntegration as definePlatformIntegration } from "@ai-translate/integrations";
import type {
  DetectedSetup as PlatformDetectedSetup,
  Integration as PlatformIntegration,
  IntegrationPlan as PlatformIntegrationPlan,
  JsonCatalogPlan,
} from "@ai-translate/integrations";

export type {
  AdapterCatalogPlan,
  ConfigImport,
  ConfigLiteral,
  DetectionContext,
  DetectionEvidence,
  JsonCatalogPlan,
  ProviderChoice,
  RenderConfigOptions,
} from "@ai-translate/integrations";

/** Next.js integrations retain their JSON-specific public contract. Compose
 * other platform adapters through `@ai-translate/integrations` instead. */
export interface CatalogPlan extends JsonCatalogPlan {}
export type CatalogKind = CatalogPlan["kind"];

export interface IntegrationPlan extends PlatformIntegrationPlan {
  additionalCatalogs?: readonly CatalogPlan[];
  catalog: CatalogPlan;
  messageFormat: "i18next" | "icu" | "plain";
}

export interface DetectedSetup extends PlatformDetectedSetup<IntegrationPlan> {}
export interface Integration extends PlatformIntegration<IntegrationPlan> {}

export function defineIntegration(integration: Integration): Integration {
  return definePlatformIntegration(integration);
}
