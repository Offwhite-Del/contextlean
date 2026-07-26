# Protocols and evaluation

Read this reference when building adapters, frozen evals, or Context Packs. The normal audit/apply workflow does not need it.

## Artifact flow

1. `snapshot` writes metadata and hashes only.
2. `experiment init` binds the snapshot, frozen tasks, quality profile, model, and reasoning level.
3. `experiment generate` sends one explicitly selected target plus non-held-out tasks to an optimizer adapter.
4. `experiment run` executes baseline and candidates through a qualified runner and sends anonymous outputs to a judge.
5. `experiment select` writes a v1 replace plan only when the quality-first gate has one Pareto winner.

Artifacts use the schemas in `../schemas/`. Keep them private and out of version control.

## Adapter contract

Use `contextlean.adapter/v1` with an absolute executable path and absolute paths for every file argument. ContextLean fingerprints every bounded regular executable/code-file argv entry with streaming SHA-256, including parsed flag values such as `--require=/path`, and rejects sensitive, oversized, relative, non-code, or unrecognized file-like arguments. It calls the executable directly with `shell: false`, sends one JSON request on stdin, and requires exactly one JSON response on stdout. Do not put environment variables, credentials, prompts, or private paths in the adapter spec. Subprocesses receive a minimal client/runtime environment; variables whose names imply keys, tokens, secrets, passwords, auth, or cookies are removed, and proxy variables are never inherited. Runner specs must bind an absolute sandbox qualification receipt path and its SHA-256; ContextLean verifies the receipt schema, passing status, policy hash, and response binding before accepting a run.

An adapter is a separate trust and network boundary. The optimizer receives the selected target, the runner receives task/context pairs, and the judge receives anonymous outputs. A Codex, Claude, or other Agent adapter may send that request to its configured provider. Use only reviewed adapters and explicitly authorized non-sensitive targets; ContextLean's zero-telemetry claim does not cover third-party adapter behavior.

Roles:

- `optimizer`: return one or two complete candidates and every preserved invariant ID.
- `runner`: receive task inputs without evaluator assertions, then return output, structured metrics, the observed model/reasoning/session/tool environment, zero-or-positive side-effect counts, and a qualified sandbox receipt hash.
- `judge`: compare anonymous outputs using only the task and rubric; do not use token, latency, cost, or variant identity.

Every unavailable metric must be `null` with a matching `unavailableReasons` entry. ContextLean does not replace missing observations with proxies. Baseline and candidate runs are paired by frozen task plus repetition; if either side lacks a metric, that metric is unavailable for promotion. A candidate with a material gain but any unavailable efficiency guardrail is routed to human review instead of automatic selection. Token and latency summaries use paired medians; latency includes only tasks marked `measureLatency` and cannot qualify as a gain with fewer than three repetitions. Tool calls, repeated reads, errors, and retries use paired totals.

## Quality-first selection

The profile defines category passes and thresholds. Selection first requires zero hard-boundary violations, deterministic non-regression, and blind non-inferiority. It then requires a material quality or efficiency gain. Multiple non-dominated winners require human review; selection never averages quality, token, and latency into one opaque score.

Use fresh sessions and equal model/reasoning/tool settings. ContextLean randomizes baseline/candidate execution order for each task and repetition. Repeat latency samples and report them as samples rather than service guarantees. Adapter evidence binds the spec, SHA-256 fingerprints for absolute argv files, and the runner sandbox receipt; observed environment and every persisted run/judgment must match those frozen bindings. A changed runner, wrapper, sandbox, or environment invalidates comparison. Raw runner outputs and judge rationales are not persisted; their hashes and sizes are retained for audit.

## Context Packs

A Context Pack is a derived, on-demand excerpt bundle. It never becomes a canonical source.

Validate all of these against current values before rendering:

- canonical source SHA-256 and version, using a separate current `contextlean.source-versions/v1` artifact;
- parser and content-schema versions;
- generation prompt SHA-256;
- permission fingerprint;
- exact line-range content hashes;
- final rendered-pack token budget, including headers and per-chunk citations.

Packs are limited to 32 sources and 128 non-duplicate exact ranges. Rendering an unverified candidate requires explicit evaluation mode. Any causal mismatch or final-render budget overflow marks the pack stale and blocks rendering.
