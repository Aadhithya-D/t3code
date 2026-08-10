# Usage

The Usage page shows cost and token totals from each provider CLI's own local
session history on every connected environment.

## What is counted

- **Claude Code** — assistant records under `~/.claude/projects`
- **Codex** — rollout sessions under `~/.codex/sessions`
- **Kiro CLI** — session sidecar metering under `~/.kiro/sessions/cli`

Turns started outside T3 Code still appear, as long as they landed in those
provider directories.

## How cost is calculated

Claude and Codex costs come from provider-reported figures when present,
otherwise from published model rates applied to the recorded tokens.

Kiro CLI bills in credits. The Usage page converts those credits at the public
overage rate ($0.04 per credit). Kiro often leaves token counters at zero, so
Kiro rows may show cost with little or no token volume.

Headline cost is an API-equivalent estimate, not a subscription invoice.
