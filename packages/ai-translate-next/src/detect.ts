import {
  detectProject as detectProjectWithIntegrations,
  detectSetups as detectSetupsWithIntegrations,
} from "@ai-translate/integrations";
import type { DetectOptions as PlatformDetectOptions } from "@ai-translate/integrations";

import { i18nextIntegration } from "./integrations/i18next";
import { nextIntlIntegration } from "./integrations/next-intl";
import type { DetectedSetup, DetectionContext, Integration, IntegrationPlan } from "./types";

export interface DetectOptions extends PlatformDetectOptions<IntegrationPlan> {}

/** Preserves the Next.js package's historical detector defaults. */
export const builtinIntegrations: readonly Integration[] = [
  nextIntlIntegration,
  i18nextIntegration,
];

export function detectSetups(
  context: DetectionContext,
  options: DetectOptions = {},
): Promise<readonly DetectedSetup[]> {
  return detectSetupsWithIntegrations(context, {
    integrations: options.integrations ?? builtinIntegrations,
  });
}

export function detectProject(
  root: string,
  options: DetectOptions = {},
): Promise<readonly DetectedSetup[]> {
  return detectProjectWithIntegrations(root, {
    integrations: options.integrations ?? builtinIntegrations,
  });
}
