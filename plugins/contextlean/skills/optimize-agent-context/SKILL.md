---
name: optimize-agent-context
description: Safely audit and optimize AI Agent context, instructions, Skills, Context Packs, plugins, hooks, and tools. Use for stale or excessive context, conflicting rules, poor Skill routing, repeated tool work, or measured before/after optimization. Do not use for ordinary code edits, model/provider tuning, or unsupported speed claims.
---

# Optimize Agent Context

Use ContextLean for deterministic measurement and rollback. Quality comes first; shorter context alone is not a win.

## Workflow

1. Set the target Agent, root, canonical state, and tasks. Separate account/global/project instructions, Skills, runtime config, Context Packs, and provider context.
2. Run the bundled CLI read-only:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs doctor --root <project> --json
   ```

   Use `audit --scope repo` when personal configuration is out of scope. Before experiments, use `snapshot --write <file>`; snapshots exclude file contents.
3. Report `Fact / Inference / Proposal / Blocked`. Verify live evidence, treat token estimates as heuristics, and change one surface at a time.
4. For candidates, frozen A/B, adapters, blind review, or Context Packs, read [protocols-and-evaluation.md](references/protocols-and-evaluation.md). Use equal fresh sessions. Promote only quality-safe material gains; selection never applies automatically.
5. Before apply or rollback, read [safety-and-method.md](references/safety-and-method.md). Review the replacement and SHA-256. With user authorization, run:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs apply --plan <plan.json> --yes
   node <skill-directory>/scripts/contextlean.mjs verify --receipt <receipt.json>
   ```

6. Roll back when validation fails:

   ```bash
   node <skill-directory>/scripts/contextlean.mjs rollback --receipt <receipt.json> --yes
   ```

## Boundaries

- Default to read-only audit, metadata-only snapshots, and dry plans. Never inspect auth files, keychains, `.env` files, private transcripts, or secrets.
- Preserve privacy, permission, destructive-action, business, canonical-source, network, model, dirty-worktree, and recovery boundaries.
- Redaction-review local reports or plans before publishing.
- Do not globally disable plugins, Skills, hooks, MCP servers, memory, or reasoning from one benchmark. Context Packs are derived caches; canonical sources win.
- Do not promise model-side acceleration or “100% capability.” Verify task quality, tool behavior, side effects, and latency before claiming improvement.
