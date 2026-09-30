import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type {
  CursorSettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CURSOR_USAGE_WINDOWS } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";
import { readMacCursorAccessToken } from "../cursorCredentialStore.ts";

/**
 * Cursor Agent subscription usage. Dashboard Connect RPC
 * `GetCurrentPeriodUsage` reports dashboard percentages and a billing cycle.
 * Older responses fall back to included spend in USD cents. File credentials
 * and optional macOS Keychain credentials support CLIs whose status output
 * no longer includes the bearer token.
 *
 * @module provider/Layers/cursorUsageLimits
 */

const MONTH_MINS = 30 * 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoFromMillis(millis: number): string | undefined {
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  const dt = DateTime.make(millis);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromUnknown(value: unknown): string | undefined {
  if (typeof value === "number") return isoFromMillis(value > 1e12 ? value : value * 1000);
  const text = asString(value);
  if (!text) return undefined;
  if (/^\d{10,13}$/.test(text)) {
    const epoch = Number(text);
    return isoFromMillis(text.length >= 13 ? epoch : epoch * 1000);
  }
  const dt = DateTime.make(text);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function durationMinsBetween(startIso: string | undefined, endIso: string | undefined): number {
  if (!startIso || !endIso) return MONTH_MINS;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return MONTH_MINS;
  return Math.max(1, Math.round((end - start) / 60_000));
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tokenFromRecord(record: Record<string, unknown>): string | undefined {
  const direct =
    asString(record.accessToken) ??
    asString(record.access_token) ??
    asString(record.token) ??
    asString(record.authToken);
  if (direct) return direct;
  if (isRecord(record.auth)) return tokenFromRecord(record.auth);
  if (isRecord(record.credentials)) return tokenFromRecord(record.credentials);
  return undefined;
}

/** Bearer token from `agent status --format json`. Booleans like `hasAccessToken` do not count. */
export function cursorStatusAccessToken(stdout: string): string | undefined {
  const parsed = parseJsonObject(stdout);
  return parsed ? tokenFromRecord(parsed) : undefined;
}

/** Bearer token from the Cursor Agent login file. */
export function cursorAuthTokenFromJson(parsed: unknown): string | undefined {
  return isRecord(parsed) ? tokenFromRecord(parsed) : undefined;
}

/**
 * Login file the Cursor Agent reads for `agent login`. Windows uses `%APPDATA%/Cursor`,
 * macOS `~/.cursor`, Linux `$XDG_CONFIG_HOME/cursor` (or `~/.config/cursor`).
 */
export function cursorCliAuthJsonPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  if (platform === "win32") {
    const appData =
      environment.APPDATA?.trim() || (home ? NodePath.join(home, "AppData", "Roaming") : "");
    return NodePath.join(appData, "Cursor", "auth.json");
  }
  if (platform === "darwin") {
    return NodePath.join(home, ".cursor", "auth.json");
  }
  const configHome = environment.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  return NodePath.join(configHome, "cursor", "auth.json");
}

function percentFromDisplayMessage(
  ...messages: ReadonlyArray<string | undefined>
): number | undefined {
  for (const message of messages) {
    const match = message?.match(/used\s+(\d+(?:\.\d+)?)\s*%/i);
    if (match) return clampPercent(Number(match[1]));
  }
  return undefined;
}

function spendUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const limit = asNumber(planUsage.limit);
  const included = asNumber(planUsage.includedSpend) ?? asNumber(planUsage.totalSpend);
  const remaining = asNumber(planUsage.remaining);
  if (limit !== undefined && limit > 0 && included !== undefined) {
    return clampPercent((included / limit) * 100);
  }
  if (limit !== undefined && limit > 0 && remaining !== undefined) {
    return clampPercent(((limit - remaining) / limit) * 100);
  }
  return undefined;
}

/**
 * Cursor's dashboard now reports Auto vs API percents separately. `includedSpend`
 * often equals `limit` once the included-dollar bucket is full, even when Auto
 * still has headroom — that ratio is not the number the product shows.
 */
function includedUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const auto = asNumber(planUsage.autoPercentUsed);
  if (auto !== undefined) return clampPercent(auto);
  const fromCopy = percentFromDisplayMessage(
    asString(planUsage.autoModelSelectedDisplayMessage),
    asString(planUsage.displayMessage),
  );
  if (fromCopy !== undefined) return fromCopy;
  const spend = spendUsedPercent(planUsage);
  if (spend !== undefined) return spend;
  const totalPercent = asNumber(planUsage.totalPercentUsed);
  return totalPercent !== undefined ? clampPercent(totalPercent) : undefined;
}

function apiUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const api = asNumber(planUsage.apiPercentUsed);
  if (api !== undefined) return clampPercent(api);
  return percentFromDisplayMessage(asString(planUsage.namedModelSelectedDisplayMessage));
}

function spendLimitWindow(
  spend: Record<string, unknown>,
  checkedAt: string,
  cycle: { start?: string; end?: string },
): ServerProviderUsageWindow | undefined {
  const limit = asNumber(spend.limit) ?? asNumber(spend.spendLimit);
  const used = asNumber(spend.used) ?? asNumber(spend.spent) ?? asNumber(spend.currentSpend);
  if (limit === undefined || limit <= 0 || used === undefined) return undefined;
  const resetsAt = isoFromUnknown(cycle.end);
  return {
    id: "spend_limit",
    kind: "monthly",
    label: "Spend limit",
    usedPercent: clampPercent((used / limit) * 100),
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins: durationMinsBetween(cycle.start, cycle.end),
  };
}

/**
 * Map `GetCurrentPeriodUsage` JSON onto monthly included-usage (and optional
 * spend-limit) windows. Returns undefined when no quota percentage is present.
 */
export function cursorPeriodUsageToLimits(input: {
  readonly payload: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  if (!isRecord(input.payload)) return undefined;
  const planUsage = isRecord(input.payload.planUsage) ? input.payload.planUsage : undefined;
  const includedPercent = planUsage
    ? includedUsedPercent(planUsage)
    : asNumber(input.payload.totalPercentUsed);
  const namedPercent = planUsage ? apiUsedPercent(planUsage) : undefined;
  if (includedPercent === undefined && namedPercent === undefined) return undefined;

  const startIso = isoFromUnknown(input.payload.billingCycleStart);
  const resetsAt = isoFromUnknown(input.payload.billingCycleEnd);
  const windowDurationMins = durationMinsBetween(startIso, resetsAt);
  const windows: ServerProviderUsageWindow[] = [];
  if (includedPercent !== undefined) {
    windows.push({
      id: "included",
      kind: "monthly",
      label: planUsage && asNumber(planUsage.autoPercentUsed) !== undefined ? "Auto" : "Included",
      usedPercent: includedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  }
  if (namedPercent !== undefined) {
    windows.push({
      id: "included_api",
      kind: "monthly",
      label: "API",
      usedPercent: namedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  }
  if (isRecord(input.payload.spendLimitUsage)) {
    const spend = spendLimitWindow(input.payload.spendLimitUsage, input.checkedAt, {
      ...(startIso ? { start: startIso } : {}),
      ...(resetsAt ? { end: resetsAt } : {}),
    });
    if (spend) windows.push(spend);
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}

const CursorCredentials = Schema.Struct({ accessToken: Schema.optional(Schema.String) });
const DEFAULT_CURSOR_API_ENDPOINT = "https://api2.cursor.sh";
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(CursorCredentials));
const CursorUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  spendLimitUsage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(
    Schema.Struct({
      includedSpend: Schema.optional(Schema.Number),
      totalSpend: Schema.optional(Schema.Number),
      remaining: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
      autoModelSelectedDisplayMessage: Schema.optional(Schema.String),
      namedModelSelectedDisplayMessage: Schema.optional(Schema.String),
      totalPercentUsed: Schema.optional(Schema.Number),
      autoPercentUsed: Schema.optional(Schema.Number),
      apiPercentUsed: Schema.optional(Schema.Number),
    }),
  ),
});

/** Cursor's dashboard percentages include bonus usage; spend / limit does not. */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const reset = DateTime.make(Number(response.billingCycleEnd));
  const resetsAt =
    Number(response.billingCycleEnd) > 0 && Option.isSome(reset)
      ? DateTime.formatIso(reset.value)
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const legacyLimits = cursorPeriodUsageToLimits({ payload: response, checkedAt });
  if (windows.length > 0) {
    windows.push(...(legacyLimits?.windows.filter((window) => window.id === "spend_limit") ?? []));
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : (legacyLimits ?? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }));
}

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
  allowKeychain = false,
  keychainToken: () => Promise<string | null> = readMacCursorAccessToken,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const endpoint = (
      settings.apiEndpoint.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      DEFAULT_CURSOR_API_ENDPOINT
    ).replace(/\/$/, "");
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    // An explicit API key can name a different account from the stored login.
    if (!token && environment.CURSOR_API_KEY?.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
    if (!token && credentialStore === "memory") {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Cursor usage requires a CLI login or CURSOR_AUTH_TOKEN.",
      });
    }
    if (!token && platform === "darwin" && credentialStore !== "file") {
      if (!allowKeychain) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Enable Cursor account usage in T3 Code to read its Keychain login.",
        });
      }
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Cursor account usage requires the default Cursor endpoint when using Keychain.",
        });
      }
      token = (yield* Effect.tryPromise(keychainToken))?.trim();
    } else if (!token) {
      const home =
        (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
      const directory =
        platform === "win32"
          ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
          : platform === "darwin"
            ? path.join(home, ".cursor")
            : path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
      const credentials = yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
        Effect.flatMap(decodeCredentials),
      );
      token = credentials.accessToken?.trim();
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return cursorUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      }),
    ),
  );
});
