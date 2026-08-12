import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, KiroIcon, OpenAI } from "../Icons";

/**
 * Series and table order. The chart layers both providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "kiro"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kiro: "Kiro CLI",
};

/** Claude's brand orange, neutral white for Codex, Kiro purple. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  kiro: "#9046FF",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills (`#d97757` for Claude, white on dark for OpenAI,
 * `#9046FF` for Kiro), which are the same colours as the chart bands, so
 * swapping a colour dot for a mark keeps the series association intact rather
 * than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  kiro: KiroIcon,
};
