import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as NodeOS from "node:os";
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

/**
 * Grok Build subscription usage. The CLI's `x.ai/billing` ACP method and the
 * CLI-proxy `GET /v1/billing?format=credits` response share a config object:
 * prefer `creditUsagePercent` + `currentPeriod`, then the older
 * `monthlyLimit` / `used` pair. A period without a percentage is unknown, not 0%.
 *
 * @module provider/Layers/grokUsageLimits
 */

const WEEK_MINS = 7 * 24 * 60;
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

function centVal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value)) return asNumber(value.val);
  return undefined;
}

function isoFromUnknown(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const dt = DateTime.make(text);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function durationMinsBetween(
  startIso: string | undefined,
  endIso: string | undefined,
): number | undefined {
  if (!startIso || !endIso) return undefined;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.max(1, Math.round((end - start) / 60_000));
}

function kindFromPeriodType(
  periodType: string | undefined,
  durationMins: number | undefined,
): ServerProviderUsageWindow["kind"] {
  const type = periodType?.toUpperCase() ?? "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (durationMins !== undefined) {
    if (durationMins >= MONTH_MINS * 0.8) return "monthly";
    if (durationMins >= WEEK_MINS * 0.8) return "weekly";
  }
  return "weekly";
}

function unwrapConfig(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.config)) return payload.config;
  if (payload.creditUsagePercent !== undefined || payload.currentPeriod !== undefined) {
    return payload;
  }
  if (payload.billingCycle !== undefined || payload.monthlyLimit !== undefined) {
    return payload;
  }
  return payload;
}

function grokBuildProductPercent(config: Record<string, unknown>): number | undefined {
  const products = config.productUsage;
  if (!Array.isArray(products)) return undefined;
  for (const entry of products) {
    if (!isRecord(entry)) continue;
    const product = (asString(entry.product) ?? "").toLowerCase().replace(/_/g, "");
    if (!product.includes("grokbuild") && product !== "productgrokbuild") continue;
    const percent = asNumber(entry.usagePercent) ?? asNumber(entry.creditUsagePercent);
    if (percent !== undefined) return percent;
  }
  return undefined;
}

function usedPercentFromConfig(config: Record<string, unknown>): number | undefined {
  const direct = asNumber(config.creditUsagePercent);
  if (direct !== undefined) return clampPercent(direct);
  const product = grokBuildProductPercent(config);
  if (product !== undefined) return clampPercent(product);

  const monthlyLimit = centVal(config.monthlyLimit) ?? centVal(config.monthly_limit);
  const used =
    centVal(config.used) ??
    (isRecord(config.usage)
      ? (centVal(config.usage.totalUsed) ?? centVal(config.usage.includedUsed))
      : undefined);
  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    return clampPercent((used / monthlyLimit) * 100);
  }

  const cap = centVal(config.onDemandCap) ?? centVal(config.on_demand_cap);
  const onDemandUsed = centVal(config.onDemandUsed) ?? centVal(config.on_demand_used);
  if (cap !== undefined && cap > 0 && onDemandUsed !== undefined) {
    return clampPercent((onDemandUsed / cap) * 100);
  }
  return undefined;
}

/**
 * Map an `x.ai/billing` ACP result or CLI-proxy credits JSON onto one Credits
 * window. Returns undefined when the payload has no usable percentage.
 */
export function grokBillingToLimits(input: {
  readonly payload: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const config = unwrapConfig(input.payload);
  if (!config) return undefined;
  const usedPercent = usedPercentFromConfig(config);
  if (usedPercent === undefined) return undefined;

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const billingCycle = isRecord(config.billingCycle) ? config.billingCycle : undefined;
  const startIso =
    isoFromUnknown(period?.start) ??
    isoFromUnknown(config.billingPeriodStart) ??
    isoFromUnknown(billingCycle?.billingPeriodStart);
  const resetsAt =
    isoFromUnknown(period?.end) ??
    isoFromUnknown(config.billingPeriodEnd) ??
    isoFromUnknown(billingCycle?.billingPeriodEnd);
  const durationMins =
    durationMinsBetween(startIso, resetsAt) ??
    (kindFromPeriodType(asString(period?.type), undefined) === "monthly" ? MONTH_MINS : WEEK_MINS);
  const kind = kindFromPeriodType(asString(period?.type), durationMins);
  const window: ServerProviderUsageWindow = {
    id: "credits",
    kind,
    label: kind === "monthly" ? "Monthly" : "Weekly",
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins: durationMins,
  };
  return makeUsageLimits({ checkedAt: input.checkedAt, windows: [window] });
}

/**
 * Pick a still-valid SuperGrok bearer from `~/.grok/auth.json`. Entries are
 * keyed by OIDC issuer URL; prefer `auth.x.ai`.
 */
export function grokAuthTokenFromJson(parsed: unknown, nowMs: number): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const entries = Object.entries(parsed)
    .filter(([, value]) => isRecord(value) && asString(value.key))
    .toSorted(([left], [right]) => {
      const score = (key: string) =>
        key.includes("auth.x.ai") ? 0 : key.includes("accounts.x.ai") ? 1 : 2;
      return score(left) - score(right);
    });
  for (const [, value] of entries) {
    if (!isRecord(value)) continue;
    const key = asString(value.key);
    if (!key) continue;
    const expiresAt = asString(value.expires_at) ?? asString(value.expiresAt);
    if (expiresAt) {
      const at = Date.parse(expiresAt);
      if (Number.isFinite(at) && at <= nowMs) continue;
    }
    return key;
  }
  return undefined;
}

const GrokCredentials = Schema.Record(
  Schema.String,
  Schema.Struct({
    key: Schema.optional(Schema.String),
    auth_mode: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
  }),
);
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(GrokCredentials));
const GrokUsageResponse = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.Number),
      currentPeriod: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          end: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

export function grokUsageResponseToLimits(
  response: typeof GrokUsageResponse.Type,
  checkedAt: string,
) {
  const usedPercent = response.config?.creditUsagePercent;
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    // A billing read that succeeded but carries no percentage is an account
    // with nothing metered yet, not one that can never report: xAI omits the
    // field entirely (rather than sending 0) until usage registers, then fills
    // it in. Calling that `unsupported` would strand the account — the Limits
    // view drops unsupported entries and deliberately mutes their notice, so a
    // freshly signed-in Grok account would vanish with no explanation until it
    // happened to be used, and `applyUsageLimitsUpdate` would refuse the
    // mid-turn windows that could have recovered it.
    return makeUsageLimits({ checkedAt, windows: [] });
  }
  const period = response.config?.currentPeriod;
  const periodType = period?.type?.replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind = periodType === "WEEKLY" ? "weekly" : periodType === "MONTHLY" ? "monthly" : "other";
  const reset = period?.end ? DateTime.make(period.end) : Option.none();
  const window: ServerProviderUsageWindow = {
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: clampPercent(usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}

/**
 * The grok.com login the CLI uses by default, or undefined when the CLI is
 * configured to pick another account, endpoint, or an API key.
 */
const readGrokCredential = Effect.fn("readGrokCredential")(function* (
  environment: NodeJS.ProcessEnv,
) {
  // T3's ACP adapter explicitly selects API-key auth when this variable is set.
  if (environment.XAI_API_KEY?.trim()) return undefined;
  // Alternate auth deployments can select another scope or account from the same file.
  if (
    [
      "GROK_OIDC_ISSUER",
      "GROK_OIDC_CLIENT_ID",
      "GROK_OAUTH2_ISSUER",
      "GROK_OAUTH2_CLIENT_ID",
      "GROK_OAUTH2_PRINCIPAL_TYPE",
      "GROK_OAUTH2_PRINCIPAL_ID",
      "GROK_AUTH_PROVIDER_COMMAND",
      "GROK_LOCAL_AUTH",
      "GROK_CLI_CHAT_PROXY_BASE_URL",
      "GROK_MODELS_BASE_URL",
      "GROK_CONFIG",
      "GROK_CONFIG_PATH",
    ].some((name) => environment[name]?.trim())
  ) {
    return undefined;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    environment.GROK_HOME?.trim() ||
    path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".grok");
  for (const configPath of [
    path.join(home, "config.toml"),
    path.join(home, "managed_config.toml"),
    path.join(home, "requirements.toml"),
    "/etc/grok/managed_config.toml",
    "/etc/grok/requirements.toml",
  ]) {
    const config = yield* fs.readFileString(configPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      }),
    );
    // These sections can change the selected account or endpoint. Leave custom deployments to the CLI.
    if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(config)) {
      return undefined;
    }
  }
  const contents =
    environment.GROK_AUTH?.trim() ||
    (yield* fs.readFileString(path.join(home, "auth.json")).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    ));
  const credentials = yield* decodeCredentials(contents);
  // Never pick an arbitrary account from other deployments stored in the same file.
  const credential =
    credentials["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ??
    credentials["https://accounts.x.ai/sign-in"];
  return credential?.auth_mode === "api_key" ? undefined : credential;
});

/**
 * Reads the default grok.com login once and reports its usage limits along with
 * its email, so the email always names the account whose quota was read.
 */
export const readGrokAccount = Effect.fn("readGrokAccount")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Grok could not read usage limits.",
  });
  const credential = yield* Effect.option(
    readGrokCredential(environment).pipe(Effect.timeout("10 seconds")),
  );
  if (Option.isNone(credential)) return { email: undefined, usageLimits: probeFailed };
  const email = credential.value?.email?.trim() || undefined;
  const token = credential.value?.key?.trim();
  if (!token) {
    return { email, usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }) };
  }
  // A failed quota request still knows which account it asked about.
  const usageLimits = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://cli-chat-proxy.grok.com/v1/billing?format=credits").pipe(
        HttpClientRequest.bearerToken(token),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(GrokUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return grokUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => probeFailed),
  );
  return { email, usageLimits };
});
