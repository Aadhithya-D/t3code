import { type KiroSettings, ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import {
  applyKiroAcpEffortChange,
  makeKiroAcpRuntime,
  resolveKiroAcpModelId,
  resolveKiroEffortFromModelSelection,
  steerKiroAcpTurn,
} from "../acp/KiroAcpSupport.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly turnInactivityTimeoutMs?: number;
  readonly activeToolInactivityTimeoutMs?: number;
  readonly concurrentPromptRetryDelaysMs?: ReadonlyArray<number>;
  readonly postPromptQuietPeriodMs?: number;
}

/**
 * Kiro uses standard ACP session, model, permission, streaming, and
 * cancellation methods, so it shares the existing hardened ACP lifecycle
 * implementation instead of maintaining a third copy of that state machine.
 *
 * Effort is a Kiro-only trait: spawn with `--effort` on session start, and
 * apply mid-session changes via `/effort` when the composer toggle changes.
 *
 * Kiro rejects concurrent `session/prompt` calls, but exposes `_session/steer`
 * for queuing plain-text follow-ups into the live prompt. Attachments and
 * failed extension requests retain the cancel-then-prompt fallback.
 */
export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  return makeGrokAdapter(kiroSettings, {
    ...options,
    provider: ProviderDriverKind.make("kiro"),
    providerDisplayName: "Kiro",
    steerInFlightTurns: false,
    steerInFlightTurn: steerKiroAcpTurn,
    // Kiro can resolve session/prompt just before its final content updates.
    // Keep the turn open through a short quiet window so those updates are
    // projected instead of being dropped as late events.
    postPromptQuietPeriodMs: options?.postPromptQuietPeriodMs ?? 750,
    resolveModelId: resolveKiroAcpModelId,
    resolveSessionEffort: resolveKiroEffortFromModelSelection,
    applySessionEffort: ({ runtime, effort }) =>
      applyKiroAcpEffortChange({
        runtime,
        effort,
      }),
    makeAcpRuntime: ({ grokSettings: _grokSettings, initialEffort, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings,
        ...(initialEffort ? { initialEffort } : {}),
      }),
  });
}
