/**
 * Kiro ACP extension notifications.
 *
 * Kiro does not use the unstable ACP `usage_update` session notification for
 * credits. Instead it streams `_kiro.dev/metadata` with context fill percentage
 * and metering (credits) after each prompt. T3 maps that into the shared
 * `thread.token-usage.updated` runtime event so the chat meter can show it.
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const KIRO_DEV_METADATA_METHOD = "_kiro.dev/metadata";

const KiroMeteringUsageEntry = Schema.Struct({
  value: Schema.Number,
  unit: Schema.optionalKey(Schema.String),
  unitPlural: Schema.optionalKey(Schema.String),
});

export const KiroDevMetadataNotification = Schema.Struct({
  sessionId: Schema.String,
  contextUsagePercentage: Schema.optionalKey(Schema.Number),
  meteringUsage: Schema.optionalKey(Schema.Array(KiroMeteringUsageEntry)),
  turnDurationMs: Schema.optionalKey(Schema.Number),
  effort: Schema.optionalKey(Schema.String),
});
export type KiroDevMetadataNotification = typeof KiroDevMetadataNotification.Type;

/** Synthetic context window size used to render Kiro's percentage as a meter. */
const KIRO_CONTEXT_WINDOW_TOKENS = 100_000;

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map a Kiro metadata notification into the shared token-usage snapshot shape.
 * Returns undefined when there is nothing useful to show (no percentage and no
 * credits), so callers can skip the runtime event.
 */
export function threadTokenUsageFromKiroMetadata(
  notification: KiroDevMetadataNotification,
): ThreadTokenUsageSnapshot | undefined {
  const percentage = finiteNonNegative(notification.contextUsagePercentage);
  const creditsEntry = notification.meteringUsage?.find(
    (entry) =>
      Number.isFinite(entry.value) &&
      entry.value >= 0 &&
      (entry.unit === "credit" ||
        entry.unit === "credits" ||
        entry.unitPlural === "credits" ||
        entry.unit === undefined),
  );
  const creditsUsed = creditsEntry ? finiteNonNegative(creditsEntry.value) : undefined;
  const durationMs = finiteNonNegative(notification.turnDurationMs);

  if (percentage === undefined && creditsUsed === undefined) {
    return undefined;
  }

  // Percentage is of the model context window. Clamp to [0, 100] then scale to
  // a synthetic max so the existing context-window meter can render a fill.
  const clampedPercentage =
    percentage === undefined ? undefined : Math.min(100, Math.max(0, percentage));
  const usedTokens =
    clampedPercentage === undefined
      ? 1 // keep the activity resolvable when only credits landed
      : Math.max(1, Math.round((clampedPercentage / 100) * KIRO_CONTEXT_WINDOW_TOKENS));

  return {
    usedTokens,
    maxTokens: KIRO_CONTEXT_WINDOW_TOKENS,
    ...(clampedPercentage !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(durationMs !== undefined && Number.isInteger(durationMs)
      ? { durationMs: Math.trunc(durationMs) }
      : {}),
    ...(creditsUsed !== undefined ? { creditsUsed } : {}),
    ...(creditsEntry?.unitPlural?.trim()
      ? { creditsUnit: creditsEntry.unitPlural.trim() }
      : creditsEntry?.unit?.trim()
        ? { creditsUnit: creditsEntry.unit.trim() }
        : creditsUsed !== undefined
          ? { creditsUnit: "credits" }
          : {}),
  };
}

/** True when a provider error is Kiro (or similar) rejecting a concurrent prompt. */
export function isPromptAlreadyInProgressMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /prompt already in progress/i.test(message);
}
