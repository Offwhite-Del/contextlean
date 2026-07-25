# ContextLean

Local, reversible context and configuration doctor for AI Agent environments.

ContextLean helps ChatGPT/Codex, Claude Code, and other Agent Skills-compatible clients spend less time and context on duplicated instructions, irrelevant capabilities, idle hooks, and conflicting configuration. It optimizes the controllable Agent harness; it does not change the model or promise model-side inference acceleration.

> Status: `0.1.0`. Read-only auditing and the hash-guarded apply/verify/rollback loop are implemented. The heuristics are intentionally conservative and pre-1.0.

## What it does

- Measures known always-on instruction files without reading source code broadly.
- Detects oversized instruction surfaces and exact repeated lines without printing their content.
- Counts discovered Skills and enabled plugins within the selected scope.
- Detects idle Codex hook loading and cross-vendor environment key names.
- Produces an Agent-readable plan scaffold with source SHA-256 hashes.
- Applies reviewed instruction/Skill replacement plans only after explicit `--yes` confirmation.
- Creates local backups and receipts, verifies post-write hashes, and rolls back exactly.
- Runs locally with zero telemetry and zero runtime dependencies beyond Node.js 18+.

## What it does not do

- Read authentication files, keychains, `.env` files, or private Agent transcripts.
- Upload prompts, configuration, source code, reports, or usage telemetry.
- Delete files, install background services, enable hooks, or add MCP servers.
- Automatically decide that shorter instructions are better.
- Promise “100% model capability” or eliminate provider/network inference latency.

## Quick start

Run directly from GitHub:

```bash
npx --yes github:Offwhite-Del/contextlean audit --scope repo
npx --yes github:Offwhite-Del/contextlean doctor
```

Or clone and run locally:

```bash
git clone https://github.com/Offwhite-Del/contextlean.git
cd contextlean
npm test
node bin/contextlean.mjs doctor
```

Commands:

```text
contextlean audit [--root PATH] [--scope repo|home|all] [--json]
contextlean doctor [--root PATH] [--home PATH] [--json]
contextlean plan [--root PATH] [--scope repo|home|all] [--write FILE]
contextlean apply --plan FILE --yes [--root PATH]
contextlean verify --receipt FILE [--json]
contextlean rollback --receipt FILE --yes
```

`audit` defaults to the current repository. `doctor` audits both repository and user Agent configuration. Neither command mutates files.

## Install for ChatGPT Desktop and Codex

Add this repository as a Codex marketplace:

```bash
codex plugin marketplace add Offwhite-Del/contextlean \
  --sparse .agents/plugins \
  --sparse plugins
codex plugin add contextlean@contextlean
```

Restart the ChatGPT desktop app or start a new Codex CLI session. Invoke the bundled Skill as `$optimize-agent-context`, or ask Codex to audit the Agent environment.

The plugin uses the official `.codex-plugin/plugin.json` format and does not bundle hooks, MCP servers, connectors, or external authentication.

## Install for Claude Code and Claude Code Desktop

```bash
claude plugin marketplace add Offwhite-Del/contextlean \
  --sparse .claude-plugin plugins
claude plugin install contextlean@contextlean
```

Reload plugins or start a new session, then invoke `/contextlean:optimize-agent-context` or ask Claude to audit the Agent environment.

The same `SKILL.md`, reference, and CLI implementation are shared by both plugin packages.

## Use with other Agents

The reusable Skill is located at:

```text
plugins/contextlean/skills/optimize-agent-context/
```

Install that folder with the target client's Agent Skills installer or copy it into the client's supported Skill directory. Agent Skills standardize the Skill contents and progressive disclosure model; installation paths still vary across products.

## Safe apply workflow

1. Generate a read-only audit and plan scaffold:

   ```bash
   contextlean audit --root . --json
   contextlean plan --root . --write .contextlean/plan.json
   ```

2. Have a human or Agent fill only reviewed `replace` operations. Each operation must contain the current SHA-256 from the audit and the complete replacement content. Version 0.1 accepts known instruction filenames and `SKILL.md`; configuration findings are advisory.
3. Review the entire plan, then apply and verify:

   ```bash
   contextlean apply --plan .contextlean/plan.json --yes
   contextlean verify --receipt .contextlean/backups/<id>/receipt.json
   ```

4. Roll back if quality, tool behavior, or representative-task results regress:

   ```bash
   contextlean rollback --receipt .contextlean/backups/<id>/receipt.json --yes
   ```

Plans, backups, and receipts live under `.contextlean/` and are ignored by Git by default.

## Method

ContextLean separates deterministic safety from contextual judgment:

- The CLI measures, hashes, backs up, applies exact reviewed content, verifies, and restores.
- The Skill tells the Agent how to classify evidence, preserve non-testable boundaries, and run representative comparisons.
- The user decides whether latency, quality, cost, or available tools matter most for the target workflow.

Approximate token counts use `bytes / 4`. Thresholds are review heuristics, not universal quality limits. A smaller prompt is an improvement only when the same representative tasks still pass.

## Initial evidence

The first real-world case reduced combined always-on rule files from 6,148 to 3,191 bytes (48.1%) and reduced the same simple Codex prompt by 751 input tokens. Single-run latency also improved, but those timings were network- and cache-sensitive and are not a product guarantee.

This case motivated the safety model: audit first, change one category at a time, preserve explicit boundaries, verify on real tasks, and keep exact rollback evidence.

## Related projects

- [PrismoDev](https://github.com/shanirsh/prismodev) focuses on local session observability, token waste, noisy command output, and later-session verification.
- [ECC](https://github.com/affaan-m/ECC) is a broad cross-harness operating system with many Skills, hooks, rules, and orchestration features.

ContextLean stays deliberately narrower: local configuration diagnosis and reversible changes without reading private session transcripts or adding a new runtime control plane.

## Development

```bash
npm ci
npm test
npm run validate
python3 /path/to/skill-creator/scripts/quick_validate.py \
  plugins/contextlean/skills/optimize-agent-context
python3 /path/to/plugin-creator/scripts/validate_plugin.py \
  plugins/contextlean
claude plugin validate plugins/contextlean
```

CI tests Node.js 18, 20, and 22 on Linux, plus Node.js 20 on macOS and Windows.

## License

Apache License 2.0. See [LICENSE](LICENSE).
