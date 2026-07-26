#!/usr/bin/env node

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = process.argv[2] || "default";
if (mode === "env-check" && (
  process.env.CONTEXTLEAN_TEST_SECRET
  || Object.entries(process.env).some(([key, value]) => /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key) && value?.includes("contextlean-proxy-sentinel"))
)) process.exit(7);

function expectedOutput(taskId) {
  const smoke = {
    "smoke-exact-response": "CONTEXT_SIMPLE_OK",
    "smoke-read-only-state": "STATE_READ_OK",
    "smoke-one-tool-call": "ONE_TOOL_OK",
    "smoke-skill-positive": "SKILL_POSITIVE_OK",
    "smoke-skill-negative": "SKILL_NEGATIVE_OK",
    "smoke-stale-pack": "STALE_PACK_REJECTED",
  };
  if (smoke[taskId]) return smoke[taskId];
  const match = taskId.match(/^(instruction|skill-positive|skill-negative|context-pack)-(\d+)$/);
  if (!match) return "UNKNOWN_TASK";
  return `${match[1].replaceAll("-", "_").toUpperCase()}_${match[2]}_OK`;
}

if (request.role === "optimizer") {
  if (request.developmentTasks.some((task) => task.heldOut)) process.exit(8);
  const invariantIds = request.invariants.map((item) => item.id);
  process.stdout.write(JSON.stringify({
    schema: "contextlean.optimizer-output/v1",
    variants: [{
      id: "optimized",
      rationale: "Preserve declared invariants and add a deterministic test marker.",
      content: `${request.target.content.trimEnd()}\n\nOPTIMIZED_CONTEXT\n`,
      preservedInvariantIds: invariantIds,
    }],
  }));
  process.exit(0);
}

if (request.role === "runner") {
  if (Object.hasOwn(request.task, "assertions")) process.exit(10);
  const optimized = request.variant.context.includes("OPTIMIZED_CONTEXT");
  const output = expectedOutput(request.task.id);
  const unavailableReasons = {};
  const metrics = {
    inputTokens: optimized ? (mode === "small-gain" ? 98 : 88) : 100,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningTokens: 1,
    toolCalls: request.task.allowedTools.length,
    repeatedReads: 0,
    toolErrors: 0,
    retries: 0,
    latencyMs: optimized ? (mode === "small-gain" ? 98 : 88) : 100,
    unavailableReasons,
  };
  if (mode === "missing-reason") {
    metrics.inputTokens = null;
  }
  if (mode === "missing-candidate-metric" && optimized) {
    metrics.inputTokens = null;
    unavailableReasons.inputTokens = "synthetic candidate metric unavailable";
  }
  if (mode === "missing-output-guardrail" && optimized) {
    metrics.outputTokens = null;
    unavailableReasons.outputTokens = "synthetic output metric unavailable";
  }
  process.stdout.write(JSON.stringify({
    schema: "contextlean.runner-output/v1",
    output,
    success: output !== "UNKNOWN_TASK",
    metrics,
    environment: request.environment,
    sideEffects: {
      unauthorizedWrites: 0,
      privacyViolations: 0,
      networkNodeChanges: 0,
      safetyViolations: 0,
    },
    sandbox: {
      qualified: mode !== "unqualified",
      receiptSha256: request.sandboxReceipt.sha256,
    },
  }));
  process.exit(0);
}

if (request.role === "judge") {
  process.stdout.write(JSON.stringify({
    schema: "contextlean.judge-output/v1",
    verdict: "tie",
    rationale: "Both anonymous outputs satisfy the supplied rubric.",
  }));
  process.exit(0);
}

process.exit(9);
