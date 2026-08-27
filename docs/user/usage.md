# Review usage

The Usage page combines Codex, Claude Code, and Kiro CLI activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token
cost, processed tokens, cache savings, provider shares, and model breakdowns. Subscription
billing is separate from the raw token cost shown here.

- **Claude Code** — assistant records under `~/.claude/projects`
- **Codex** — rollout sessions under `~/.codex/sessions`
- **Kiro CLI** — session sidecar metering under `~/.kiro/sessions/cli`

Turns started outside T3 Code still appear, as long as they landed in those provider directories.

Claude and Codex costs come from provider-reported figures when present, otherwise from
published model rates applied to the recorded tokens. Kiro CLI bills in credits; the page
converts those credits at the public overage rate ($0.04 per credit). Kiro often leaves token
counters at zero, so Kiro rows may show cost with little or no token volume.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
