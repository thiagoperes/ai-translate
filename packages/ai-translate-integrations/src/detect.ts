import { createDetectionContext } from "./context";
import type { DetectedSetup, DetectionContext, Integration, IntegrationPlan } from "./types";

export interface DetectOptions<Plan extends IntegrationPlan = IntegrationPlan> {
  /** Detectors are composed by the caller; this package has no platform dependencies. */
  integrations?: readonly Integration<Plan>[];
}

/** Runs read-only detectors independently and returns matches in confidence order. */
export async function detectSetups<Plan extends IntegrationPlan = IntegrationPlan>(
  context: DetectionContext,
  options: DetectOptions<Plan> = {},
): Promise<readonly DetectedSetup<Plan>[]> {
  const results = await Promise.all(
    (options.integrations ?? []).map(async (integration) => {
      try {
        return await integration.detect(context);
      } catch {
        // One integration probing an unfamiliar layout must not abort other detectors.
        return null;
      }
    }),
  );
  return results
    .filter((result): result is DetectedSetup<Plan> => result !== null)
    .toSorted((left, right) => right.confidence - left.confidence);
}

export function detectProject<Plan extends IntegrationPlan = IntegrationPlan>(
  root: string,
  options: DetectOptions<Plan> = {},
): Promise<readonly DetectedSetup<Plan>[]> {
  return detectSetups(createDetectionContext(root), options);
}
