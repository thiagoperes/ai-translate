import { renderConfig as renderPlatformConfig } from "@ai-translate/integrations";

import type { IntegrationPlan, RenderConfigOptions } from "./types";

export function renderConfig(plan: IntegrationPlan, options: RenderConfigOptions = {}): string {
  return renderPlatformConfig(plan, options);
}
