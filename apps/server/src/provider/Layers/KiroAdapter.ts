import { type KiroSettings, ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import {
  applyKiroAcpEffortChange,
  makeKiroAcpRuntime,
  resolveKiroAcpModelId,
  resolveKiroEffortFromModelSelection,
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
}

/**
 * Kiro uses standard ACP session, model, permission, streaming, and
 * cancellation methods, so it shares the existing hardened ACP lifecycle
 * implementation instead of maintaining a third copy of that state machine.
 *
 * Effort is a Kiro-only trait: spawn with `--effort` on session start, and
 * apply mid-session changes via `/effort` when the composer toggle changes.
 *
 * Kiro rejects concurrent `session/prompt` calls, so a follow-up message
 * cancels the live turn instead of Grok-style steering.
 */
export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  return makeGrokAdapter(kiroSettings, {
    ...options,
    provider: ProviderDriverKind.make("kiro"),
    providerDisplayName: "Kiro",
    steerInFlightTurns: false,
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
