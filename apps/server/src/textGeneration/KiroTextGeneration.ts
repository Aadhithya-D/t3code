import type { KiroSettings } from "@t3tools/contracts";

import {
  makeKiroAcpRuntime,
  resolveKiroAcpModelId,
  resolveKiroEffortFromModelSelection,
} from "../provider/acp/KiroAcpSupport.ts";
import { makeGrokTextGeneration } from "./GrokTextGeneration.ts";

export const makeKiroTextGeneration = (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  makeGrokTextGeneration(settings, environment, {
    providerDisplayName: "Kiro",
    resolveModelId: resolveKiroAcpModelId,
    resolveSessionEffort: resolveKiroEffortFromModelSelection,
    makeAcpRuntime: ({ grokSettings: _grokSettings, initialEffort, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings: settings,
        ...(initialEffort ? { initialEffort } : {}),
      }),
  });
