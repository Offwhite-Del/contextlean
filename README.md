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

ContextLean is a local, reversible, evidence-driven context optimizer for AI coding agents. It helps Codex, ChatGPT Desktop, Claude Code, and other Agent Skills-compatible clients improve controllable harness context without pretending to accelerate the model provider itself.

> **Status:** the `v0.2.0` working tree adds metadata-only snapshots, pluggable optimization experiments, quality-first selection, and source-backed Context Packs to the original hash-guarded apply/rollback loop. Thresholds remain review gates, not universal quality limits.

## Why ContextLean

Agent performance is shaped by two different systems:

| Layer | ContextLean can improve | ContextLean cannot change |
| --- | --- | --- |
| Local agent harness | Always-on instructions, discovered Skills, enabled plugins, idle hooks, cross-vendor configuration | — |
| Model provider | — | Inference speed, capacity, routing, rate limits, or model capability |

ContextLean makes the controllable layer measurable, testable, and reversible. A candidate is accepted only when frozen tasks prove a material quality or efficiency gain.

## What it does

1. **Measure** known surfaces with content-free snapshots and causal hashes.
2. **Diagnose** oversized or conflicting rules, Skill metadata/body load, idle hooks, and cross-vendor configuration.
3. **Generate bounded candidates** through an argv-based optimizer adapter without embedding provider credentials.
4. **Evaluate** baseline and candidates on frozen tasks through a qualified runner and anonymous judge.
5. **Select quality first**; write a plan only for one material, non-dominated winner.
6. **Render source-backed Context Packs** only while their source, parser, schema, prompt, permission, citation, and final-render budget bindings remain current.
7. **Apply, verify, or roll back** reviewed replacements with exact hashes and backups.

ContextLean orchestration runs locally with zero product telemetry and zero runtime dependencies beyond Node.js 18+. User-supplied experiment adapters are separate subprocesses: an Agent adapter may contact its configured model provider. Review that adapter and the explicitly selected non-sensitive data before running `experiment generate` or `experiment run`.

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
ContextLean 0.2.0
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
contextlean snapshot --root PATH --scope repo|home|all --write FILE
contextlean plan [--root PATH] [--scope repo|home|all] [--write FILE]
contextlean experiment init --snapshot FILE --tasks FILE --profile FILE --model NAME --reasoning LEVEL --write FILE
contextlean experiment generate --experiment FILE --adapter FILE --target PATH --write FILE
contextlean experiment run --experiment FILE --candidate FILE --runner FILE --judge FILE --write FILE
contextlean experiment select --experiment FILE --candidate FILE --result FILE --report FILE [--write-plan FILE]
contextlean pack validate --manifest FILE --source-versions FILE --root PATH --permission-fingerprint VALUE --parser-version VALUE --content-schema-version VALUE --prompt-sha256 SHA
contextlean pack render --manifest FILE --source-versions FILE --root PATH --permission-fingerprint VALUE --parser-version VALUE --content-schema-version VALUE --prompt-sha256 SHA --write FILE [--allow-candidate]
contextlean apply --plan FILE --yes [--root PATH]
contextlean verify --receipt FILE [--json]
contextlean rollback --receipt FILE --yes
```

## Evidence-driven experiment

Use [`examples/optimization/`](examples/optimization/) as the public 6-task smoke, 24-task frozen, smoke-profile, and full-profile starting point. These fixtures exercise protocol and gate behavior; fake-adapter tests are not evidence of a real Agent quality or speed gain. On POSIX, ContextLean writes experiment artifacts with mode `0600`. On Windows, it inherits the containing directory ACL, so use a user-private `.contextlean/` directory and keep all artifacts out of version control.

Adapters use [`contextlean.adapter/v1`](plugins/contextlean/skills/optimize-agent-context/schemas/adapter.schema.json): an absolute executable, absolute paths for file arguments, one JSON request on stdin, and one JSON response on stdout. Runner adapters must bind a passing sandbox qualification receipt by SHA-256 and report the observed model/reasoning/session/tool environment. Optimizers receive non-held-out tasks only; runners never receive deterministic assertions; persisted results contain output and judge-rationale hashes rather than raw text. ContextLean does not inherit proxy environment variables into adapters, and incomplete efficiency guardrails require human review. The adapter receives the selected target or task output and may send it to its configured provider; ContextLean does not embed credentials or silently choose a provider. Full protocol details live in the [on-demand reference](plugins/contextlean/skills/optimize-agent-context/references/protocols-and-evaluation.md).

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

ContextLean accepts complete replacements only for known instruction filenames and `SKILL.md`. Each operation must contain the current SHA-256. If a source changes after plan creation, ContextLean refuses to overwrite it. Configuration findings remain advisory.

## Safety boundaries

ContextLean does **not**:

- read authentication files, keychains, `.env` files, secret values, or private Agent transcripts;
- upload prompts, configuration, source code, reports, or telemetry;
- delete files, install services, enable hooks, or add MCP servers;
- automatically decide that shorter instructions are better;
- send held-out tasks to the candidate generator or persist raw evaluation output;
- auto-apply a selected candidate or treat a Context Pack as canonical state;
- promise “100% model capability” or eliminate provider/network latency.

The first item describes ContextLean itself. A user-selected Agent adapter may use the network and transmit its explicit request to that Agent's configured provider. Do not select confidential or private targets unless that provider path is separately authorized.

Plans, backups, and receipts remain under `.contextlean/`, which is ignored by Git by default. Review them separately before sharing.

## Method and initial evidence

The CLI owns deterministic work: measurement, artifact binding, adapter contracts, causal invalidation, quality gates, hashes, backups, exact writes, verification, and restoration. The Skill owns contextual judgment: what to preserve, what to move on demand, and which representative tasks represent real quality.

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
  skills/optimize-agent-context/           Skill, schemas, references, and CLI
examples/optimization/                     Public smoke/full tasks and quality profile
test/*.test.mjs                            Cross-platform safety and experiment tests
.agents/plugins/marketplace.json           Codex marketplace
.claude-plugin/marketplace.json            Claude marketplace
```

## Contributing

Bug reports and focused improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening an issue or pull request. Releases are documented in [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
