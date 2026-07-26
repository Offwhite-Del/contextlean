<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/contextlean-hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/contextlean-hero-light.svg">
  <img src="assets/contextlean-hero-light.svg" alt="ContextLean — Measure. Trim. Verify. Roll back." width="100%">
</picture>

<div align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</div>

<div align="center">
  <a href="https://github.com/Offwhite-Del/contextlean/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Offwhite-Del/contextlean/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Offwhite-Del/contextlean/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Offwhite-Del/contextlean?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/github/license/Offwhite-Del/contextlean"></a>
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white">
</div>

ContextLean is a local, reversible context and configuration doctor for AI coding agents. It helps Codex, ChatGPT Desktop, Claude Code, and other Agent Skills-compatible clients reduce avoidable harness overhead without pretending to accelerate the model provider itself.

> **Status:** `v0.1.0` implements read-only audits and a hash-guarded plan/apply/verify/rollback loop. Its thresholds are conservative review heuristics, not universal quality limits.

## Why ContextLean

Agent performance is shaped by two different systems:

| Layer | ContextLean can improve | ContextLean cannot change |
| --- | --- | --- |
| Local agent harness | Always-on instructions, discovered Skills, enabled plugins, idle hooks, cross-vendor configuration | — |
| Model provider | — | Inference speed, capacity, routing, rate limits, or model capability |

ContextLean makes the controllable layer measurable and reversible. A shorter prompt is accepted as an improvement only when representative tasks still pass.

## What it does

1. **Measure** known instruction surfaces without broadly reading source code.
2. **Diagnose** oversized rules, exact duplicate lines, Skill/plugin load, idle Codex hooks, and cross-vendor environment key names.
3. **Plan** reviewed replacements with source SHA-256 hashes.
4. **Apply safely** only after explicit confirmation, with backups and receipts.
5. **Verify or roll back** using exact post-write and backup hashes.

Everything runs locally with zero telemetry and zero runtime dependencies beyond Node.js 18+.

## Quick start

Run directly from GitHub:

```bash
npx --yes github:Offwhite-Del/contextlean audit --scope repo
npx --yes github:Offwhite-Del/contextlean doctor
```

Or clone and verify locally:

```bash
git clone https://github.com/Offwhite-Del/contextlean.git
cd contextlean
npm test
node bin/contextlean.mjs doctor
```

`audit` defaults to the current repository. `doctor` audits both repository and user-level Agent configuration. Neither command changes files.

## See it work

Running the read-only repository audit on ContextLean itself produces:

```text
ContextLean 0.1.0
Scope: repo
Instructions: 1 files, 499 bytes (~125 tokens)
Skills: 0; enabled plugins: 0
Privacy: no auth files, secret values, or session transcripts read
Findings: none at current heuristic thresholds
```

The output reports measurements and heuristic findings, not a promise that every repository with no findings is optimally configured.

## Commands

```text
contextlean audit [--root PATH] [--scope repo|home|all] [--json]
contextlean doctor [--root PATH] [--home PATH] [--json]
contextlean plan [--root PATH] [--scope repo|home|all] [--write FILE]
contextlean apply --plan FILE --yes [--root PATH]
contextlean verify --receipt FILE [--json]
contextlean rollback --receipt FILE --yes
```

## Install as an Agent Skill

### ChatGPT Desktop and Codex

```bash
codex plugin marketplace add Offwhite-Del/contextlean \
  --sparse .agents/plugins \
  --sparse plugins
codex plugin add contextlean@contextlean
```

Restart ChatGPT Desktop or open a new Codex CLI session, then invoke `$optimize-agent-context` or ask Codex to audit the Agent environment.

### Claude Code and Claude Code Desktop

```bash
claude plugin marketplace add Offwhite-Del/contextlean \
  --sparse .claude-plugin plugins
claude plugin install contextlean@contextlean
```

Reload plugins or open a new session, then invoke `/contextlean:optimize-agent-context` or ask Claude to audit the Agent environment.

### Other Agent Skills clients

The portable Skill lives at [`plugins/contextlean/skills/optimize-agent-context/`](plugins/contextlean/skills/optimize-agent-context/). Install that folder with the target client's Skill installer or copy it into a supported Skill directory. The Skill, reference, and CLI implementation are shared by the Codex and Claude packages to prevent drift.

## Safe apply workflow

```bash
contextlean audit --root . --json
contextlean plan --root . --write .contextlean/plan.json
# Review and complete the replace operations in the plan.
contextlean apply --plan .contextlean/plan.json --yes
contextlean verify --receipt .contextlean/backups/<id>/receipt.json
contextlean rollback --receipt .contextlean/backups/<id>/receipt.json --yes
```

Version 0.1 accepts complete replacements only for known instruction filenames and `SKILL.md`. Each operation must contain the current SHA-256. If a source changes after plan creation, ContextLean refuses to overwrite it. Configuration findings remain advisory.

## Safety boundaries

ContextLean does **not**:

- read authentication files, keychains, `.env` files, secret values, or private Agent transcripts;
- upload prompts, configuration, source code, reports, or telemetry;
- delete files, install services, enable hooks, or add MCP servers;
- automatically decide that shorter instructions are better;
- promise “100% model capability” or eliminate provider/network latency.

Plans, backups, and receipts remain under `.contextlean/`, which is ignored by Git by default. Review them separately before sharing.

## Method and initial evidence

The CLI owns deterministic work: measurement, hashes, backups, exact writes, verification, and restoration. The Skill owns contextual judgment: what to preserve, what to move on demand, and which representative tasks must still pass.

The first real-world case reduced combined always-on rules from 6,148 to 3,191 bytes (48.1%) and reduced the same simple Codex prompt by 751 input tokens. A single-run latency improvement was also observed, but it was network- and cache-sensitive and is **not** a product benchmark or guarantee.

## Related projects

- [PrismoDev](https://github.com/shanirsh/prismodev) focuses on local session observability, token waste, noisy output, and later-session verification.
- [ECC](https://github.com/affaan-m/ECC) provides a broad cross-harness collection of Skills, hooks, rules, and orchestration features.
- [OpenSSF Scorecard](https://github.com/ossf/scorecard) measures open-source security practices; it complements ContextLean but does not optimize Agent context.

ContextLean remains deliberately narrow: diagnose local Agent configuration and make reviewed changes reversible, without reading private session transcripts or adding a new runtime control plane.

## Project layout

```text
bin/contextlean.mjs                         CLI entry point
plugins/contextlean/                       Codex and Claude plugin package
  skills/optimize-agent-context/           Portable Agent Skill
test/contextlean.test.mjs                  Cross-platform behavior tests
.agents/plugins/marketplace.json           Codex marketplace
.claude-plugin/marketplace.json            Claude marketplace
```

## Contributing

Bug reports and focused improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening an issue or pull request. Releases are documented in [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
