import {
  type KiroSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

/** Effort levels accepted by `kiro-cli acp --effort` and the `/effort` slash command. */
export const KIRO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type KiroEffortLevel = (typeof KIRO_EFFORT_LEVELS)[number];
export const KIRO_DEFAULT_EFFORT: KiroEffortLevel = "medium";
/** Option descriptor id shown in the composer traits picker. */
export const KIRO_EFFORT_OPTION_ID = "effort";

/**
 * Kiro can pause a turn to ask the user for a decision via `session/elicitation`.
 * Advertising the form capability lets Kiro use structured elicitation, which the
 * shared ACP adapter surfaces through T3 Code's user-input flow. `url` mode is
 * intentionally not advertised because the client cannot render URL elicitations.
 */
const KIRO_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

type KiroAcpRuntimeSettings = Pick<KiroSettings, "binaryPath">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Initial thinking effort for `kiro-cli acp --effort`. */
  readonly initialEffort?: string | null | undefined;
}

export function normalizeKiroEffort(value: string | null | undefined): KiroEffortLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalized;
    case "extra-high":
    case "extra high":
    case "extra_high":
      return "xhigh";
    default:
      return undefined;
  }
}

export function resolveKiroEffortFromSelections(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): KiroEffortLevel | undefined {
  return normalizeKiroEffort(
    getProviderOptionStringSelectionValue(selections, KIRO_EFFORT_OPTION_ID) ??
      getProviderOptionStringSelectionValue(selections, "reasoningEffort"),
  );
}

export function resolveKiroEffortFromModelSelection(
  modelSelection:
    | {
        readonly model?: string | null | undefined;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | null
    | undefined,
): KiroEffortLevel | undefined {
  return resolveKiroEffortFromSelections(modelSelection?.options);
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  initialEffort?: string | null | undefined,
): AcpSessionRuntime.AcpSpawnInput {
  const effort = normalizeKiroEffort(initialEffort);
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: ["acp", ...(effort ? (["--effort", effort] as const) : [])],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Kiro authenticates through its CLI login or `KIRO_API_KEY`; unlike Cursor
 * and Grok, its ACP server does not expose the optional `authenticate` RPC.
 */
export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(
          input.kiroSettings,
          input.cwd,
          input.environment,
          input.initialEffort,
        ),
        clientCapabilities: KIRO_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Apply a mid-session effort change via Kiro's `/effort` slash command.
 *
 * Kiro's local ACP agent does not implement `session/set_config_option`. The
 * slash command does update effort, but the `session/prompt` RPC often never
 * settles, so we race a short timeout and always cancel to unstick the agent
 * before the real user prompt runs.
 */
export function applyKiroAcpEffortChange(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "prompt" | "cancel">;
  readonly effort: string;
}): Effect.Effect<void> {
  const effort = normalizeKiroEffort(input.effort);
  if (!effort) {
    return Effect.void;
  }
  return input.runtime
    .prompt({
      prompt: [{ type: "text", text: `/effort ${effort}` }],
    })
    .pipe(
      Effect.timeout(Duration.millis(2_500)),
      Effect.ignore,
      Effect.ensuring(input.runtime.cancel.pipe(Effect.ignore)),
    );
}

export function resolveKiroAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  // Keep the advertised "default" slug as a real model id so selecting it after
  // a custom model issues session/set_model instead of "do not switch" (undefined).
  if (!trimmed) {
    return undefined;
  }
  return normalizeModelSlug(trimmed, KIRO_DRIVER_KIND) ?? trimmed;
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
