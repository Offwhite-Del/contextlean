---
name: optimize-agent-context
description: Audit, benchmark, and safely optimize local AI Agent context, instructions, Skills, Context Packs, plugins, hooks, and cross-vendor configuration. Use when ChatGPT/Codex, Claude Code, or another CLI Agent starts with excessive or stale context, routes Skills poorly, repeats tool work, has conflicting rules, or needs evidence-backed before/after optimization with rollback. Do not use for ordinary code edits, model/provider tuning, or unsupported speed claims.
---

# Optimize Agent Context

Use ContextLean as the deterministic measurement, evaluation, and rollback layer. Optimize relevance, freshness, trigger precision, and tool behavior; never equate shorter context with better results.

## Workflow

1. Establish the target Agent, project root, current canonical state, quality priority, and representative tasks. Keep account UI instructions, global/project rules, Skills, runtime configuration, Context Packs, and provider-fixed context separate.
2. Run the bundled CLI read-only:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs doctor --root <project> --json
   ```

   Use `audit --scope repo` when personal Agent configuration is out of scope. Use `snapshot --write <file>` before an optimization experiment; snapshots contain metadata and hashes, not file contents.
3. Report `Fact / Inference / Proposal / Blocked`. Verify findings against real files and runtime state. Treat byte-to-token conversion and thresholds as heuristics.
4. Select one reviewed surface at a time. Preserve privacy, permission, destructive-action, business, canonical-source, network, model, dirty-worktree, and recovery boundaries. Move only task-specific detail into on-demand Skills or references.
5. For candidate generation, frozen A/B tasks, adapters, blind review, or Context Packs, read [protocols-and-evaluation.md](references/protocols-and-evaluation.md). Confirm the selected target is non-sensitive and the adapter/provider data path is authorized. Keep held-out tasks hidden from the optimizer and require a qualified runner sandbox.
6. Run smoke tasks before the full frozen suite. Track deterministic success, blind non-inferiority, input/cache tokens, latency samples, tool calls, repeated reads, errors, retries, and side effects. Do not promote a candidate without a material quality or efficiency gain.
7. Use `experiment select` to create a compatible v1 plan only when one candidate passes the quality-first gate. Review the full replacement and current SHA-256; selection never applies automatically.
8. If the user authorizes the reviewed change, run:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs apply --plan <plan.json> --yes
   node <skill-directory>/scripts/contextlean.mjs verify --receipt <receipt.json>
   ```

9. Roll back when validation fails:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs rollback --receipt <receipt.json> --yes
   ```

Read [safety-and-method.md](references/safety-and-method.md) before any apply or rollback operation.

## Boundaries

- Default to read-only audit, metadata-only snapshots, and dry plans.
- Never inspect auth files, keychains, `.env` files, private session transcripts, or secret values.
- Never publish local reports or plans without a separate redaction review.
- Do not disable plugins, Skills, hooks, MCP servers, memory, or reasoning globally from one benchmark.
- Treat Context Packs as derived, on-demand caches; canonical sources always win and candidate packs require explicit evaluation mode.
- Do not promise model-side inference acceleration or “100% capability.” Optimize the controllable Agent harness and verify the quality/latency tradeoff.
