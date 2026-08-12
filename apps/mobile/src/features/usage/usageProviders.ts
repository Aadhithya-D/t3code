import type { UsageProviderKind } from "@t3tools/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "kiro"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kiro: "Kiro CLI",
};

/**
 * Claude's brand orange holds in both themes; Codex is neutral and must flip
 * with the theme or its bars vanish against the matching background. Kiro's
 * purple is readable on light and dark surfaces as-is.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    kiro: "#9046FF",
  };
}
