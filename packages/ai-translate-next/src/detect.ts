import { createDetectionContext } from "./context";
import { i18nextIntegration } from "./integrations/i18next";
import { nextIntlIntegration } from "./integrations/next-intl";
import type { DetectedSetup, DetectionContext, Integration } from "./types";

/** Shipped integrations, in the order they are offered when confidence ties. */
export const builtinIntegrations: readonly Integration[] = [
  nextIntlIntegration,
  i18nextIntegration,
];

export interface DetectOptions {
  /** Overrides the shipped set, for tests or for a project that registers its
   * own integration. */
  integrations?: readonly Integration[];
}

/**
 * Runs every integration against a project and returns the matches, best first.
 *
 * More than one can match — a repository migrating from i18next to next-intl
 * has both — so this returns all of them and leaves the choice to the caller.
 */
export async function detectSetups(
  context: DetectionContext,
  options: DetectOptions = {},
): Promise<readonly DetectedSetup[]> {
  const integrations = options.integrations ?? builtinIntegrations;
  const results = await Promise.all(
    integrations.map(async (integration) => {
      try {
        return await integration.detect(context);
      } catch {
        // One integration probing an unfamiliar layout must never abort the
        // whole scan.
        return null;
      }
    }),
  );

  return results
    .filter((result): result is DetectedSetup => result !== null)
    .toSorted((left, right) => right.confidence - left.confidence);
}

export async function detectProject(
  root: string,
  options: DetectOptions = {},
): Promise<readonly DetectedSetup[]> {
  return detectSetups(createDetectionContext(root), options);
}
