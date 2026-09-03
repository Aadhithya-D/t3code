/**
 * Kiro ACP extension notifications.
 *
 * Kiro does not use the unstable ACP `usage_update` session notification for
 * credits. Instead it streams `_kiro.dev/metadata` with context fill percentage
 * and metering (credits) after each prompt. T3 maps that into the shared
 * `thread.token-usage.updated` runtime event so the chat meter can show it.
 *
 * Subagents run as nested ACP sessions (and `_kiro.dev/session/*` pings). The
 * parent turn often goes silent while they work, so adapters must treat those
 * notifications as watchdog liveness and `task.*` rows.
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

const PROMPT_ALREADY_IN_PROGRESS_RE = /prompt already in progress/i;
const BARE_INTERNAL_ERROR_RE = /(?:^|:\s*)internal error\.?$/i;
const MAX_ERROR_DIAGNOSTIC_DEPTH = 6;

/** True when a provider error is Kiro (or similar) rejecting a concurrent prompt. */
export function isPromptAlreadyInProgressMessage(message: string | undefined): boolean {
  if (!message) return false;
  return PROMPT_ALREADY_IN_PROGRESS_RE.test(message);
}

/**
 * JSON-RPC `-32603` often surfaces as this exact label. Kiro puts the real
 * reason in `error.data`, so adapters must not treat the generic message as a
 * unique failure on its own unless a cancel just left a prompt in flight.
 */
export function isBareJsonRpcInternalErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return BARE_INTERNAL_ERROR_RE.test(message.trim());
}

function diagnosticTextsFromUnknown(value: unknown, depth: number, seen: Set<unknown>): string[] {
  if (value == null || depth > MAX_ERROR_DIAGNOSTIC_DEPTH) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const texts: string[] = [];
  if (value instanceof Error && value.message.trim().length > 0) {
    texts.push(value.message.trim());
  }
  if ("message" in value && typeof value.message === "string" && value.message.trim()) {
    texts.push(value.message.trim());
  }
  if (
    "errorMessage" in value &&
    typeof value.errorMessage === "string" &&
    value.errorMessage.trim()
  ) {
    texts.push(value.errorMessage.trim());
  }
  if ("detail" in value && typeof value.detail === "string" && value.detail.trim()) {
    texts.push(value.detail.trim());
  }
  if ("data" in value) {
    texts.push(...diagnosticTextsFromUnknown(value.data, depth + 1, seen));
  }
  if ("cause" in value) {
    texts.push(...diagnosticTextsFromUnknown(value.cause, depth + 1, seen));
  }
  return texts;
}

/** True when Kiro (or a similar ACP agent) rejected a prompt because one is already running. */
export function isConcurrentPromptRejection(error: unknown): boolean {
  return diagnosticTextsFromUnknown(error, 0, new Set()).some((text) =>
    isPromptAlreadyInProgressMessage(text),
  );
}

/**
 * Whether `session/prompt` should cancel, wait, and retry.
 *
 * Matches `Prompt already in progress` in the public message or `error.data`.
 * After a local cancel, also matches a bare JSON-RPC `Internal error` — Kiro
 * keeps that detail in `data`, and Effect's RPC decoder often drops it.
 */
export function isRetryableBusySessionPromptError(
  error: unknown,
  options?: { readonly recentlyCancelled?: boolean },
): boolean {
  if (isConcurrentPromptRejection(error)) {
    return true;
  }
  if (!options?.recentlyCancelled) {
    return false;
  }
  return diagnosticTextsFromUnknown(error, 0, new Set()).some((text) =>
    isBareJsonRpcInternalErrorMessage(text),
  );
}

export const KIRO_DEV_SUBAGENT_LIST_UPDATE_METHOD = "_kiro.dev/subagent/list_update";
export const KIRO_DEV_SESSION_UPDATE_METHOD = "_kiro.dev/session/update";
export const KIRO_DEV_INBOX_NOTIFICATION_METHOD = "_kiro.dev/session/inbox_notification";
export const KIRO_DEV_AGENT_SWITCHED_METHOD = "_kiro.dev/agent/switched";
export const KIRO_SESSION_TERMINATE_METHOD = "_session/terminate";

const KiroSubagentListEntry = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  agentId: Schema.optionalKey(Schema.String),
  subagentId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  lastToolName: Schema.optionalKey(Schema.String),
});
export type KiroSubagentListEntry = typeof KiroSubagentListEntry.Type;

export const KiroSubagentListUpdateNotification = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Array(KiroSubagentListEntry)),
  subagents: Schema.optionalKey(Schema.Array(KiroSubagentListEntry)),
});
export type KiroSubagentListUpdateNotification = typeof KiroSubagentListUpdateNotification.Type;

export const KiroSessionTerminateNotification = Schema.Struct({
  sessionId: Schema.String,
});
export type KiroSessionTerminateNotification = typeof KiroSessionTerminateNotification.Type;

const KiroThoughtContent = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
});

export const KiroDevSessionUpdateNotification = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  sessionUpdate: Schema.optionalKey(Schema.String),
  update: Schema.optionalKey(
    Schema.Struct({
      sessionUpdate: Schema.optionalKey(Schema.String),
      toolCallId: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      kind: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(KiroThoughtContent),
    }),
  ),
  toolCallId: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(KiroThoughtContent),
  agentName: Schema.optionalKey(Schema.String),
});
export type KiroDevSessionUpdateNotification = typeof KiroDevSessionUpdateNotification.Type;

export const KiroDevInboxNotification = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  messageCount: Schema.optionalKey(Schema.Number),
  senders: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type KiroDevInboxNotification = typeof KiroDevInboxNotification.Type;

export const KiroDevAgentSwitchedNotification = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  agentName: Schema.optionalKey(Schema.String),
  previousAgentName: Schema.optionalKey(Schema.String),
  welcomeMessage: Schema.optionalKey(Schema.String),
});
export type KiroDevAgentSwitchedNotification = typeof KiroDevAgentSwitchedNotification.Type;

const SUBAGENT_SPAWN_TITLE_RE =
  /\b(subagent|use_subagent|spawn_sub_agent|spawn_sub_agents|spawn_run)\b/i;

function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function kiroSubagentIdFromRecord(value: unknown): string | undefined {
  if (typeof value === "string") {
    return trimmedNonEmpty(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return (
    trimmedNonEmpty(record.sessionId) ??
    trimmedNonEmpty(record.childSessionId) ??
    trimmedNonEmpty(record.agentId) ??
    trimmedNonEmpty(record.subagentId) ??
    trimmedNonEmpty(record.id)
  );
}

/** True when an ACP tool call is Kiro (or similar) spawning a subagent. */
export function isAcpSubagentSpawnTool(toolCall: {
  readonly title?: string;
  readonly kind?: string;
  readonly data: Record<string, unknown>;
}): boolean {
  if (SUBAGENT_SPAWN_TITLE_RE.test(toolCall.title ?? "")) {
    return true;
  }
  const rawInput = toolCall.data.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const name =
      trimmedNonEmpty((rawInput as Record<string, unknown>).name) ??
      trimmedNonEmpty((rawInput as Record<string, unknown>).tool) ??
      trimmedNonEmpty((rawInput as Record<string, unknown>).variant);
    if (name && SUBAGENT_SPAWN_TITLE_RE.test(name)) {
      return true;
    }
  }
  return false;
}

/** Best-effort child session / agent id from a spawn tool payload. */
export function kiroSubagentIdFromToolCall(toolCall: {
  readonly toolCallId: string;
  readonly data: Record<string, unknown>;
}): string {
  return (
    kiroSubagentIdFromRecord(toolCall.data) ??
    kiroSubagentIdFromRecord(toolCall.data.rawInput) ??
    toolCall.toolCallId
  );
}

export function kiroSubagentEntriesFromListUpdate(
  notification: KiroSubagentListUpdateNotification,
): ReadonlyArray<KiroSubagentListEntry> {
  return notification.agents ?? notification.subagents ?? [];
}

export function kiroSubagentEntryId(entry: KiroSubagentListEntry): string | undefined {
  return kiroSubagentIdFromRecord(entry);
}

const TERMINAL_SUBAGENT_STATUS_RE = /^(completed|failed|cancelled|stopped|terminated|done)$/i;

export function isKiroSubagentTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_SUBAGENT_STATUS_RE.test(status.trim());
}

export function kiroVendorSessionUpdateKind(
  notification: KiroDevSessionUpdateNotification,
): string | undefined {
  return (
    trimmedNonEmpty(notification.sessionUpdate) ??
    trimmedNonEmpty(notification.update?.sessionUpdate)
  );
}

/**
 * Only a distinct ACP session id is a subagent. Parent-session
 * `_kiro.dev/session/update` tool chunks reuse the root sessionId and put the
 * ordinary tool id on `toolCallId` — that must not become a child agent.
 */
export function kiroVendorChildSessionId(
  notification: KiroDevSessionUpdateNotification,
  parentSessionId: string | undefined,
): string | undefined {
  const sessionId = trimmedNonEmpty(notification.sessionId);
  if (sessionId && sessionId !== parentSessionId) {
    return sessionId;
  }
  return undefined;
}

export function kiroVendorSessionUpdateTitle(
  notification: KiroDevSessionUpdateNotification,
): string | undefined {
  return (
    trimmedNonEmpty(notification.title) ??
    trimmedNonEmpty(notification.update?.title) ??
    trimmedNonEmpty(notification.agentName) ??
    trimmedNonEmpty(notification.content?.text) ??
    trimmedNonEmpty(notification.update?.content?.text)
  );
}

export function isKiroVendorExtensionMethod(method: string): boolean {
  return method.startsWith("_kiro.") || method === KIRO_SESSION_TERMINATE_METHOD;
}
