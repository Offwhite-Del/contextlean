---
name: optimize-agent-context
description: Audit and safely optimize local AI agent context, rules, skills, plugins, hooks, and cross-vendor configuration. Use when ChatGPT/Codex, Claude Code, or another CLI agent feels slow, starts with too much context, has conflicting instructions, loads irrelevant capabilities, or needs a measured, reversible environment cleanup.
---

# Optimize Agent Context

Use ContextLean as the deterministic measurement and rollback layer. Apply judgment to decide what should change; never equate shorter context with better results.

## Workflow

1. Establish the target agent, project root, quality priority, and representative task.
2. Run the bundled CLI read-only:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs doctor --root <project> --json
   ```

   Use `audit --scope repo` when personal Agent configuration is out of scope.
3. Report `Fact / Inference / Proposal / Blocked`. Treat byte-to-token conversion and thresholds as heuristics.
4. Preserve privacy, permission, destructive-action, business, and recovery boundaries. Move only task-specific detail into on-demand Skills or references.
5. Compare representative tasks before and after. Track input tokens, cache behavior, latency, task success, tool success, and regressions.
6. If the user authorizes changes, create a ContextLean plan with hash-guarded `replace` operations. Run:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs apply --plan <plan.json> --yes
   node <skill-directory>/scripts/contextlean.mjs verify --receipt <receipt.json>
   ```

7. Roll back when validation fails:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs rollback --receipt <receipt.json> --yes
   ```

Read [safety-and-method.md](references/safety-and-method.md) before any apply or rollback operation.

## Boundaries

- Default to read-only audit and dry plans.
- Never inspect auth files, keychains, `.env` files, private session transcripts, or secret values.
- Never publish local reports or plans without a separate redaction review.
- Do not disable plugins, Skills, hooks, MCP servers, memory, or reasoning globally from one benchmark.
- Do not promise model-side inference acceleration or “100% capability.” Optimize the controllable Agent harness and verify the quality/latency tradeoff.
