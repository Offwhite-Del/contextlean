# Safety and method

## Authority

Use current live configuration and canonical project files before memory, old reports, or copied examples. A stale optimization plan must fail its SHA-256 guard instead of being silently rebased.

## What may be optimized

- Repeated or obsolete always-on instructions
- Task-specific material that belongs in an on-demand Skill or reference
- Disabled hook infrastructure with an active global loader
- Cross-vendor environment variables proven unnecessary in the launching Agent
- Plugins, Skills, and MCP servers whose low relevance is supported by representative use
- Excessive tool output, repeated reads, or avoidable initialization paths
- Skill trigger descriptions, on-demand disclosure, and source-backed Context Pack selection

## What must remain explicit

- Privacy and credential boundaries
- Permissions and destructive-action approval
- Business stop lines and human-review gates
- Recovery paths and current authoritative state
- Deterministic test, schema, and output contracts

## Apply contract

Use plan schema version 1:

```json
{
  "schemaVersion": 1,
  "root": "/absolute/target/root",
  "operations": [
    {
      "type": "replace",
      "path": "AGENTS.md",
      "expectedSha256": "sha256-from-audit",
      "contentSha256": "sha256-of-complete-replacement",
      "content": "complete replacement content"
    }
  ]
}
```

Keep plans under `.contextlean/`, which should stay out of version control. Review the complete replacement content before running `apply --yes`. ContextLean accepts only known instruction filenames and `SKILL.md`; configuration findings remain advisory because configuration files may contain credentials or unrelated runtime behavior.

## Experiment contract

- Keep snapshots metadata-only. Candidate generation is the only step that reads an explicitly selected target body.
- On POSIX, use private `0600` artifacts. On Windows, use a directory with a user-private ACL. Keep artifacts out of version control on every platform.
- Use adapter specs with an absolute executable and absolute paths for every file argument so every executable/script can be fingerprinted. Do not put environment variables, credentials, prompts, or private paths in adapter specs. ContextLean passes only a minimal environment and does not inherit credential-like or proxy variables.
- Give optimizers only non-held-out tasks. Require runners to return a qualified sandbox receipt.
- Never give evaluator assertions to the runner. Persist output/rationale hashes and structured metrics, not raw Agent outputs or judge rationale text.
- Represent unavailable observations as `null` plus an explicit reason. Never replace missing measurements with token or latency proxies.
- Keep model, reasoning, tool permissions, task fixtures, adapter fingerprints, and sandbox receipt equal across A/B runs. Require the runner to report its observed environment.
- Treat a result as `no_proven_gain` unless it passes deterministic and blind quality gates plus a material quality or efficiency threshold.

## Context Pack contract

Context Packs are derived caches. Bind each pack to canonical source hashes and versions, parser/content-schema/prompt versions, permission fingerprint, exact cited ranges, and a final-render token budget that includes headers and citations. Supply current source versions through a separate `contextlean.source-versions/v1` artifact. Validation streams the full source for its hash but materializes only selected ranges. Any mismatch makes the pack stale. Do not render candidate packs outside explicit evaluation mode, and never promote them to canonical state automatically.

## Validation

Use at least one realistic task for a bounded change and a frozen suite for promotion. A smaller file, successful command, or lower token count is not sufficient. Verify task quality, required evidence, tool behavior, latency, side effects, and recovery. Record single-run measurements as samples rather than guarantees.
