// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads usage from Kiro CLI session sidecars.
 *
 * Kiro CLI stores each session as a four-file bundle under
 * `~/.kiro/sessions/cli/`. Conversation text lives in the `.jsonl` transcript,
 * but token/credit metering lives on the companion `.json` sidecar in
 * `session_state.conversation_metadata.user_turn_metadatas`. Token counters are
 * often zero; credits in `metering_usage` are the billing truth, converted to
 * USD at the public overage rate.
 *
 * @module usageKiroReader
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

/**
 * Public Kiro overage rate: $20 / 1,000 credits.
 *
 * Subscription included credits still bill against this rate when estimating
 * API-equivalent spend, matching the same "never understate" approach used for
 * raw token cost elsewhere on the usage page.
 */
export const USD_PER_KIRO_CREDIT = 0.04;

export interface KiroUsageReadResult {
  readonly records: readonly UsageRecord[];
  readonly scannedFiles: number;
  readonly skippedFiles: number;
  readonly malformedRecords: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function sumCredits(meteringUsage: unknown): number {
  if (!Array.isArray(meteringUsage)) return 0;
  let total = 0;
  for (const entry of meteringUsage) {
    const record = object(entry);
    if (record === null) continue;
    const unit = record["unit"];
    if (unit !== "credit" && unit !== "credits") continue;
    const value = record["value"];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

function sessionModel(document: Record<string, unknown>): string {
  const sessionState = object(document["session_state"]);
  const modelState = object(sessionState?.["rts_model_state"]);
  const modelInfo = object(modelState?.["model_info"]);
  const modelId = modelInfo?.["model_id"];
  if (typeof modelId === "string" && modelId.trim().length > 0) return modelId.trim();
  const modelName = modelInfo?.["model_name"];
  if (typeof modelName === "string" && modelName.trim().length > 0) return modelName.trim();
  return "";
}

function turnModelId(turn: Record<string, unknown>): string | null {
  const result = object(turn["result"]);
  const ok = object(result?.["Ok"] ?? result?.["ok"]);
  const content = ok?.["content"];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const record = object(block);
    const data = object(record?.["data"]);
    const modelId = data?.["modelId"] ?? data?.["model_id"];
    if (typeof modelId === "string" && modelId.trim().length > 0) return modelId.trim();
  }
  return null;
}

/** Maps one Kiro user-turn metadata entry into the shared usage record. */
export function parseKiroTurn(
  turn: unknown,
  sessionId: string,
  fallbackModel: string,
): UsageRecord | null {
  const record = object(turn);
  if (record === null) return null;

  const timestampMs = parseTimestampMs(record["end_timestamp"]);
  if (timestampMs === null) return null;

  const model = turnModelId(record) ?? fallbackModel;
  if (model.length === 0) return null;

  const credits = sumCredits(record["metering_usage"]);
  const inputTokens = positiveInt(record["input_token_count"]);
  const outputTokens = positiveInt(record["output_token_count"]);
  const totals = {
    uncachedInputTokens: inputTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  };

  // Credits are the billing signal; token fields are often left at zero.
  if (credits <= 0 && totalTokens(totals) === 0) return null;

  return {
    provider: "kiro",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd: credits > 0 ? credits * USD_PER_KIRO_CREDIT : null,
    dedupeKey: `kiro:${sessionId}:${record["end_timestamp"]}`,
  };
}

/** Parses one Kiro session sidecar document into usage records. */
export function parseKiroSessionDocument(document: unknown): readonly UsageRecord[] {
  const root = object(document);
  if (root === null) return [];

  const sessionId =
    typeof root["session_id"] === "string" && root["session_id"].trim().length > 0
      ? root["session_id"].trim()
      : "";
  if (sessionId.length === 0) return [];

  const sessionState = object(root["session_state"]);
  const conversation = object(sessionState?.["conversation_metadata"]);
  const turns = conversation?.["user_turn_metadatas"];
  if (!Array.isArray(turns) || turns.length === 0) return [];

  const model = sessionModel(root);
  const records: UsageRecord[] = [];
  for (const turn of turns) {
    const record = parseKiroTurn(turn, sessionId, model);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Default Kiro CLI session directory: `~/.kiro/sessions/cli`. */
export function resolveKiroSessionsDir(homePath: string): string {
  return NodePath.join(homePath, ".kiro", "sessions", "cli");
}

async function listSessionSidecars(
  root: string,
  sinceMs: number,
): Promise<readonly { path: string; mtimeMs: number }[]> {
  const found: { path: string; mtimeMs: number }[] = [];
  let entries;
  try {
    entries = await NodeFSP.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const child = NodePath.join(root, entry.name);
    try {
      const stats = await NodeFSP.stat(child);
      if (stats.mtimeMs >= sinceMs) found.push({ path: child, mtimeMs: stats.mtimeMs });
    } catch {
      // Sidecar rotated while the directory walk was in flight.
    }
  }
  return found;
}

/** Reads Kiro CLI usage from session sidecars under `sessionsDir`. */
export async function readKiroUsage(
  sessionsDir: string,
  sinceMs: number,
): Promise<KiroUsageReadResult | null> {
  try {
    const files = await listSessionSidecars(sessionsDir, sinceMs);
    const records: UsageRecord[] = [];
    let skippedFiles = 0;
    let malformedRecords = 0;

    for (const file of files) {
      try {
        const raw = await NodeFSP.readFile(file.path, "utf8");
        const document = JSON.parse(raw) as unknown;
        const parsed = parseKiroSessionDocument(document);
        if (parsed.length === 0) {
          skippedFiles += 1;
          continue;
        }
        // Drop turns whose day cannot possibly be in the mtime-slack window.
        for (const record of parsed) {
          if (record.timestampMs >= sinceMs) records.push(record);
        }
      } catch {
        malformedRecords += 1;
      }
    }

    return {
      records,
      scannedFiles: files.length,
      skippedFiles,
      malformedRecords,
    };
  } catch {
    return null;
  }
}
