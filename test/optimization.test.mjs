import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  applyPlan,
  auditEnvironment,
  rollbackReceipt,
} from "../plugins/contextlean/skills/optimize-agent-context/scripts/contextlean.mjs";
import {
  createSnapshot,
  evaluateAssertions,
  generateCandidates,
  hashArtifact,
  hashValue,
  initExperiment,
  inspectAdapterBinding,
  invokeAdapter,
  renderContextPack,
  readPrivateJson,
  runExperiment,
  selectExperiment,
  validateContextPack,
  writeCandidates,
  writeExperiment,
  writeExperimentResult,
  writePrivateJson,
  writeSnapshot,
} from "../plugins/contextlean/skills/optimize-agent-context/scripts/optimization.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeAdapter = path.join(repositoryRoot, "test", "fixtures", "fake-adapter.mjs");
const profileFixture = path.join(repositoryRoot, "examples", "optimization", "profile.json");
const smokeProfileFixture = path.join(repositoryRoot, "examples", "optimization", "smoke-profile.json");
const smokeTasksFixture = path.join(repositoryRoot, "examples", "optimization", "smoke-tasks.json");
const tasksFixture = path.join(repositoryRoot, "examples", "optimization", "full-tasks.json");
const bundledSkill = path.join(repositoryRoot, "plugins", "contextlean", "skills", "optimize-agent-context", "SKILL.md");

test("bundled Skill stays concise and preserves progressive-disclosure boundaries", () => {
  const content = fs.readFileSync(bundledSkill, "utf8");

  assert.ok(Buffer.byteLength(content) <= 2_600, "Bundled Skill exceeds its 2,600-byte disclosure budget.");
  assert.match(content, /Do not use for ordinary code edits, model\/provider tuning, or unsupported speed claims/);
  assert.match(content, /Quality comes first; shorter context alone is not a win/);
  assert.match(content, /protocols-and-evaluation\.md/);
  assert.match(content, /safety-and-method\.md/);
  assert.match(content, /contextlean\.mjs apply/);
  assert.match(content, /contextlean\.mjs verify/);
  assert.match(content, /contextlean\.mjs rollback/);
  assert.match(content, /Never inspect auth files, keychains, `\.env` files, private transcripts, or secrets/);
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "contextlean-v2-test-"));
  const root = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { base, root, home };
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function adapterSpec(role, mode, sandboxReceipt) {
  const spec = {
    schema: "contextlean.adapter/v1",
    role,
    argv: [process.execPath, fakeAdapter, ...(mode ? [mode] : [])],
    timeoutMs: 10_000,
  };
  if (role === "runner") spec.sandboxReceipt = sandboxReceipt;
  return spec;
}

function writeSourceVersions(base, versions) {
  const sourceVersionsPath = path.join(base, "source-versions.json");
  writePrivateJson(sourceVersionsPath, { schema: "contextlean.source-versions/v1", versions });
  return sourceVersionsPath;
}

test("private artifact readers reject sensitive paths before schema handling", () => {
  const { base } = fixture();
  const envrcPath = path.join(base, ".envrc");
  const transcriptPath = path.join(base, ".claude", "projects", "private-thread.json");
  write(envrcPath, JSON.stringify({ harmlessTestMarker: true }));
  write(transcriptPath, JSON.stringify({ harmlessTestMarker: true }));

  assert.throws(() => readPrivateJson(envrcPath), /sensitive file path/);
  assert.throws(() => readPrivateJson(transcriptPath), /sensitive file path/);
});

test("private artifact readers reject parent symlinks into private agent trees", { skip: process.platform === "win32" }, () => {
  const { base } = fixture();
  const privateDirectory = path.join(base, ".claude", "projects");
  const privateArtifact = path.join(privateDirectory, "private-thread.json");
  const safeAlias = path.join(base, "reviewed-artifacts");
  write(privateArtifact, JSON.stringify({ harmlessTestMarker: true }));
  fs.symlinkSync(privateDirectory, safeAlias, "dir");

  assert.throws(() => readPrivateJson(path.join(safeAlias, "private-thread.json")), /sensitive resolved file path/);
});

function preparePipeline(options = {}) {
  const { base, root, home } = fixture();
  const target = path.join(root, "AGENTS.md");
  write(target, options.targetContent || "# Rules\nPreserve safety and verify real outcomes.\n");
  write(path.join(root, "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Use for sample context audits.\n---\n\n# Sample\n\nRead details on demand.\n");
  const audit = auditEnvironment({ root, home, scope: "repo" });
  const snapshot = createSnapshot({ root, home, scope: "repo", auditReport: audit });
  const snapshotPath = path.join(base, "snapshot.json");
  writeSnapshot(snapshot, snapshotPath);
  const experiment = initExperiment({
    snapshotPath,
    tasksPath: options.tasksPath || tasksFixture,
    profilePath: options.profilePath || profileFixture,
    model: "gpt-5.6-sol",
    reasoning: "high",
    repetitions: 1,
  });
  const experimentPath = path.join(base, "experiment.json");
  writeExperiment(experiment, experimentPath);
  const optimizerPath = path.join(base, "optimizer.json");
  writePrivateJson(optimizerPath, adapterSpec("optimizer"));
  const sandboxReceiptPath = path.join(base, "sandbox-receipt.json");
  writePrivateJson(sandboxReceiptPath, {
    schema: "contextlean.sandbox-receipt/v1",
    qualified: true,
    backend: "test-fixture",
    policySha256: "b".repeat(64),
  });
  const sandboxReceipt = { path: sandboxReceiptPath, sha256: hashValue(fs.readFileSync(sandboxReceiptPath)) };
  return { base, root, home, target, snapshot, snapshotPath, experiment, experimentPath, optimizerPath, sandboxReceipt };
}

function citationAssertionFixture() {
  const { base } = fixture();
  const sourceRelativePath = "fixtures/facts.md";
  const sourceContent = "first fact\n \u200b \nthird fact\nlast fact";
  write(path.join(base, sourceRelativePath), sourceContent);
  const assertion = {
    jsonField: "facts",
    citationField: "citation",
    minItems: 3,
    sources: [{ path: sourceRelativePath, sha256: hashValue(sourceContent) }],
  };
  const task = {
    id: "citation-hard-gate",
    category: "citation",
    prompt: "Return frozen facts as JSON with exact citations.",
    dataClass: "non_sensitive",
    heldOut: false,
    allowedTools: ["read_file"],
    assertions: { jsonFileLineCitations: assertion },
  };
  const response = (output) => ({
    output,
    success: true,
    metrics: { toolCalls: 1, repeatedReads: 0 },
    sideEffects: { unauthorizedWrites: 0, privacyViolations: 0, networkNodeChanges: 0, safetyViolations: 0 },
  });
  return { base, sourceRelativePath, sourceContent, assertion, task, response };
}

function oneTaskProfile(category) {
  return {
    schema: "contextlean.profile/v1",
    invariants: [{ id: "citation-integrity", description: "Reject citations that do not resolve to non-empty frozen source lines." }],
    objectives: ["Keep deterministic quality non-regressing."],
    qualityGates: {
      requiredCategoryPasses: { [category]: 1 },
      minBlindNonInferior: 1,
      maxBlindLosses: 0,
      minBlindNetWins: 1,
      minInputTokenImprovementPct: 5,
      minToolImprovementPct: 10,
      minLatencyImprovementPct: 10,
      maxOtherRegressionPct: 10,
    },
  };
}

function writeInlineRunner(filePath, output) {
  const source = `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.role !== "runner" || Object.hasOwn(request.task, "assertions")) process.exit(10);
process.stdout.write(JSON.stringify({
  schema: "contextlean.runner-output/v1",
  output: ${JSON.stringify(output)},
  success: true,
  metrics: {
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningTokens: 1,
    toolCalls: 1,
    repeatedReads: 0,
    toolErrors: 0,
    retries: 0,
    latencyMs: 10,
    unavailableReasons: {},
  },
  environment: request.environment,
  sideEffects: { unauthorizedWrites: 0, privacyViolations: 0, networkNodeChanges: 0, safetyViolations: 0 },
  sandbox: { qualified: true, receiptSha256: request.sandboxReceipt.sha256 },
}));
`;
  write(filePath, source);
}

function runPipeline(mode = "default") {
  const prepared = preparePipeline();
  const candidate = generateCandidates({
    experimentPath: prepared.experimentPath,
    adapterPath: prepared.optimizerPath,
    targetPath: prepared.target,
  });
  const candidatePath = path.join(prepared.base, "candidate.json");
  writeCandidates(candidate, candidatePath);
  const runnerPath = path.join(prepared.base, "runner.json");
  const judgePath = path.join(prepared.base, "judge.json");
  writePrivateJson(runnerPath, adapterSpec("runner", mode, prepared.sandboxReceipt));
  writePrivateJson(judgePath, adapterSpec("judge"));
  const result = runExperiment({
    experimentPath: prepared.experimentPath,
    candidatePath,
    runnerPath,
    judgePath,
  });
  const resultPath = path.join(prepared.base, "result.json");
  writeExperimentResult(result, resultPath);
  const selection = selectExperiment({
    experimentPath: prepared.experimentPath,
    candidatePath,
    resultPath,
  });
  return { ...prepared, candidate, candidatePath, result, resultPath, selection };
}

test("snapshot separates controllable surfaces without including file contents", () => {
  const prepared = preparePipeline();
  const serialized = JSON.stringify(prepared.snapshot);
  const kinds = new Set(prepared.snapshot.surfaces.map((surface) => surface.kind));

  assert.equal(prepared.snapshot.schema, "contextlean.snapshot/v2");
  assert.ok(kinds.has("project_instruction"));
  assert.ok(kinds.has("skill_metadata"));
  assert.ok(kinds.has("skill_body"));
  assert.ok(kinds.has("account_custom_instructions"));
  assert.ok(kinds.has("fixed_context"));
  assert.equal(serialized.includes("Preserve safety and verify real outcomes"), false);
  assert.equal(prepared.snapshot.privacy.contentIncluded, false);
});

test("file-line citation assertions require allowlisted existing non-empty source lines", () => {
  const citation = citationAssertionFixture();
  const evaluate = (output) => evaluateAssertions(citation.task, citation.response(output), { tasksRoot: citation.base });
  const valid = evaluate(JSON.stringify({ facts: [
    { citation: `${citation.sourceRelativePath}:1` },
    { citation: `${citation.sourceRelativePath}:3` },
    { citation: `${citation.sourceRelativePath}:4` },
  ] }));
  assert.equal(valid.pass, true, "first, interior, and last non-empty lines should pass");

  const failures = [
    ["not-json", "json"],
    [JSON.stringify({ wrong: [] }), "fieldArray"],
    [JSON.stringify({ facts: [{ wrong: `${citation.sourceRelativePath}:1` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:string"],
    [JSON.stringify({ facts: [{ citation: 1 }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:string"],
    [JSON.stringify({ facts: [{ citation: "unknown.md:1" }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:allowlist"],
    [JSON.stringify({ facts: [{ citation: "/tmp/facts.md:1" }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:allowlist"],
    [JSON.stringify({ facts: [{ citation: "../facts.md:1" }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:allowlist"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:0` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:syntax"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:-1` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:syntax"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:1.5` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:syntax"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:１` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:syntax"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:١` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:syntax"],
    [JSON.stringify({ facts: [{ citation: "fixtures\\facts.md:1" }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:4` }] }), "0:allowlist"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:1` }, { citation: `${citation.sourceRelativePath}:3` }, { citation: `${citation.sourceRelativePath}:5` }] }), "2:exists"],
    [JSON.stringify({ facts: [{ citation: `${citation.sourceRelativePath}:1` }, { citation: `${citation.sourceRelativePath}:2` }, { citation: `${citation.sourceRelativePath}:4` }] }), "1:nonEmpty"],
  ];
  for (const [output, failedCheck] of failures) {
    const result = evaluate(output);
    assert.equal(result.pass, false, `expected ${failedCheck} to fail`);
    assert.ok(result.checks.some((check) => check.name.endsWith(failedCheck) && check.ok === false), `missing failed check ${failedCheck}`);
  }
});

test("citation assertion configuration rejects unsafe or unbound source paths during task validation", () => {
  for (const unsafePath of ["/tmp/facts.md", "../facts.md", "missing/facts.md", "C:\\facts.md", "fixtures\\facts.md", "fixtures/./facts.md"]) {
    const citation = citationAssertionFixture();
    const tasksPath = path.join(citation.base, "tasks.json");
    const profilePath = path.join(citation.base, "profile.json");
    const tasks = { schema: "contextlean.tasks/v1", tasks: [structuredClone(citation.task)] };
    tasks.tasks[0].assertions.jsonFileLineCitations.sources[0].path = unsafePath;
    write(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
    write(profilePath, `${JSON.stringify(oneTaskProfile("citation"), null, 2)}\n`);
    assert.throws(() => preparePipeline({ tasksPath, profilePath }), /must be relative|escapes root|non-regular|missing|portable forward-slash|non-canonical/);
  }
});

test("citation hard gate runs inside experiment scoring without leaking assertions to the runner", () => {
  for (const validOutput of [true, false]) {
    const citation = citationAssertionFixture();
    const tasksPath = path.join(citation.base, "tasks.json");
    const profilePath = path.join(citation.base, "profile.json");
    write(tasksPath, `${JSON.stringify({ schema: "contextlean.tasks/v1", tasks: [citation.task] }, null, 2)}\n`);
    write(profilePath, `${JSON.stringify(oneTaskProfile("citation"), null, 2)}\n`);
    const prepared = preparePipeline({ tasksPath, profilePath });
    const candidate = generateCandidates({ experimentPath: prepared.experimentPath, adapterPath: prepared.optimizerPath, targetPath: prepared.target });
    const candidatePath = path.join(prepared.base, "candidate.json");
    writeCandidates(candidate, candidatePath);
    const output = JSON.stringify({ facts: [
      { citation: `${citation.sourceRelativePath}:1` },
      { citation: `${citation.sourceRelativePath}:3` },
      { citation: `${citation.sourceRelativePath}:${validOutput ? 4 : 5}` },
    ] });
    const inlineRunner = path.join(prepared.base, `runner-${validOutput}.mjs`);
    writeInlineRunner(inlineRunner, output);
    const runnerPath = path.join(prepared.base, "runner.json");
    const judgePath = path.join(prepared.base, "judge.json");
    writePrivateJson(runnerPath, {
      schema: "contextlean.adapter/v1",
      role: "runner",
      argv: [process.execPath, inlineRunner],
      timeoutMs: 10_000,
      sandboxReceipt: prepared.sandboxReceipt,
    });
    writePrivateJson(judgePath, adapterSpec("judge"));
    const result = runExperiment({ experimentPath: prepared.experimentPath, candidatePath, runnerPath, judgePath });
    const passes = [result.baselineRuns[0].deterministicPass, result.candidates[0].runs[0].deterministicPass];
    assert.deepEqual(passes, [validOutput, validOutput]);
    assert.ok(result.baselineRuns[0].checks.some((check) => check.name.endsWith(validOutput ? ":nonEmpty" : ":exists") && check.ok === validOutput));
  }
});

test("synthetic 24-task protocol fixture selects only its declared metric gain and emits a v1 apply plan", () => {
  const pipeline = runPipeline();

  assert.equal(pipeline.experiment.tasks.count, 24);
  assert.equal(pipeline.experiment.tasks.heldOutCount, 8);
  assert.equal(pipeline.candidate.generator.heldOutTasksDisclosed, false);
  assert.equal(pipeline.result.privacy.rawOutputsPersisted, false);
  assert.equal(JSON.stringify(pipeline.result).includes("Both anonymous outputs satisfy"), false);
  assert.equal(JSON.stringify(pipeline.result).includes('"rationale":'), false);
  assert.equal(pipeline.selection.report.status, "selected");
  assert.match(pipeline.selection.report.selectionSha256, /^[a-f0-9]{64}$/);
  assert.equal(pipeline.selection.report.candidates[0].classification, "efficiency_improved");
  assert.equal(pipeline.selection.plan.schemaVersion, 1);
  assert.equal(pipeline.selection.plan.selection.reportSha256, pipeline.selection.report.selectionSha256);
  assert.equal(pipeline.selection.plan.operations[0].contentSha256, pipeline.candidate.variants[0].contentSha256);

  const planPath = path.join(pipeline.base, "plan.json");
  writePrivateJson(planPath, pipeline.selection.plan);
  const applied = applyPlan(planPath, { yes: true, root: pipeline.root });
  assert.match(fs.readFileSync(pipeline.target, "utf8"), /OPTIMIZED_CONTEXT/);
  rollbackReceipt(applied.receiptPath, { yes: true, root: pipeline.root });
  assert.doesNotMatch(fs.readFileSync(pipeline.target, "utf8"), /OPTIMIZED_CONTEXT/);
});

test("a two-percent sample improvement is recorded but not promoted", () => {
  const pipeline = runPipeline("small-gain");

  assert.equal(pipeline.selection.report.status, "no_promotion");
  assert.equal(pipeline.selection.report.candidates[0].classification, "no_proven_gain");
  assert.equal(pipeline.selection.plan, null);
});

test("an incomplete paired candidate metric cannot be used for promotion", () => {
  const pipeline = runPipeline("missing-candidate-metric");

  assert.equal(pipeline.selection.report.status, "no_promotion");
  assert.equal(pipeline.selection.report.candidates[0].metrics.improvementPct.inputTokens, null);
  assert.equal(pipeline.selection.report.candidates[0].metrics.availability.inputTokens.complete, false);
  assert.match(pipeline.selection.report.candidates[0].metrics.availability.inputTokens.unavailableReason, /missing-paired-values/);
});

test("a gain with an unavailable efficiency guardrail requires human review", () => {
  const pipeline = runPipeline("missing-output-guardrail");

  assert.equal(pipeline.selection.report.status, "human_review_required");
  assert.equal(pipeline.selection.report.candidates[0].classification, "human_review_required");
  assert.ok(pipeline.selection.report.candidates[0].gates.incompleteGuardrails.includes("outputTokens"));
  assert.equal(pipeline.selection.plan, null);
});

test("selection rejects dropped runs and changed adapter bindings even with a recomputed self-hash", () => {
  const pipeline = runPipeline();

  const dropped = structuredClone(pipeline.result);
  dropped.candidates[0].runs.pop();
  delete dropped.resultSha256;
  dropped.resultSha256 = hashArtifact(dropped);
  const droppedPath = path.join(pipeline.base, "result-dropped.json");
  write(droppedPath, `${JSON.stringify(dropped, null, 2)}\n`);
  assert.throws(() => selectExperiment({ experimentPath: pipeline.experimentPath, candidatePath: pipeline.candidatePath, resultPath: droppedPath }), /run count does not match/);

  const rebound = structuredClone(pipeline.result);
  rebound.candidates[0].runs[0].adapterBindingSha256 = "a".repeat(64);
  delete rebound.resultSha256;
  rebound.resultSha256 = hashArtifact(rebound);
  const reboundPath = path.join(pipeline.base, "result-rebound.json");
  write(reboundPath, `${JSON.stringify(rebound, null, 2)}\n`);
  assert.throws(() => selectExperiment({ experimentPath: pipeline.experimentPath, candidatePath: pipeline.candidatePath, resultPath: reboundPath }), /adapter binding changed or was tampered/);
});

test("runner metrics require explicit unavailable reasons and a qualified sandbox", () => {
  const prepared = preparePipeline();
  const candidate = generateCandidates({ experimentPath: prepared.experimentPath, adapterPath: prepared.optimizerPath, targetPath: prepared.target });
  const candidatePath = path.join(prepared.base, "candidate.json");
  writeCandidates(candidate, candidatePath);
  const judgePath = path.join(prepared.base, "judge.json");
  writePrivateJson(judgePath, adapterSpec("judge"));

  const missingReasonPath = path.join(prepared.base, "runner-missing-reason.json");
  writePrivateJson(missingReasonPath, adapterSpec("runner", "missing-reason", prepared.sandboxReceipt));
  assert.throws(() => runExperiment({ experimentPath: prepared.experimentPath, candidatePath, runnerPath: missingReasonPath, judgePath }), /Unavailable reason for inputTokens/);

  const unqualifiedPath = path.join(prepared.base, "runner-unqualified.json");
  writePrivateJson(unqualifiedPath, adapterSpec("runner", "unqualified", prepared.sandboxReceipt));
  assert.throws(() => runExperiment({ experimentPath: prepared.experimentPath, candidatePath, runnerPath: unqualifiedPath, judgePath }), /qualified sandbox/);
});

test("adapter specs reject shell-style relative executables and credential fields", () => {
  const { base } = fixture();
  const relativePath = path.join(base, "relative.json");
  writePrivateJson(relativePath, { schema: "contextlean.adapter/v1", role: "judge", argv: ["node", "script.mjs"], timeoutMs: 1000 });
  assert.throws(() => invokeAdapter(relativePath, "judge", { role: "judge" }), /absolute path/);

  const relativeScriptPath = path.join(base, "relative-script.json");
  writePrivateJson(relativeScriptPath, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, "test/fixtures/fake-adapter.mjs"], timeoutMs: 1000 });
  assert.throws(() => invokeAdapter(relativeScriptPath, "judge", { role: "judge" }), /file arguments must be absolute paths/);

  const hookPath = path.join(base, "hook.cjs");
  write(hookPath, "module.exports = {};\n");
  const flagFilePath = path.join(base, "flag-file.json");
  writePrivateJson(flagFilePath, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, `--require=${hookPath}`, fakeAdapter], timeoutMs: 1000 });
  const firstBinding = invokeAdapter(flagFilePath, "judge", { role: "judge" }).binding;
  assert.equal(firstBinding.executableFingerprint.length, 3);
  write(hookPath, "module.exports = { changed: true };\n");
  const secondBinding = invokeAdapter(flagFilePath, "judge", { role: "judge" }).binding;
  assert.notEqual(secondBinding.bindingSha256, firstBinding.bindingSha256);

  const attachedShortPath = path.join(base, "attached-short.json");
  writePrivateJson(attachedShortPath, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, `-r${hookPath}`, fakeAdapter], timeoutMs: 1000 });
  assert.equal(inspectAdapterBinding(attachedShortPath, "judge").executableFingerprint.length, 3);

  const javaAgentPath = path.join(base, "java-agent.json");
  writePrivateJson(javaAgentPath, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, `-javaagent:${hookPath}`, fakeAdapter], timeoutMs: 1000 });
  assert.equal(inspectAdapterBinding(javaAgentPath, "judge").executableFingerprint.length, 3);

  const sensitiveHookPath = path.join(base, ".claude", "projects", "hook.cjs");
  write(sensitiveHookPath, "module.exports = {};\n");
  const sensitiveHookSpec = path.join(base, "sensitive-hook.json");
  writePrivateJson(sensitiveHookSpec, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, `--require=${sensitiveHookPath}`, fakeAdapter], timeoutMs: 1000 });
  assert.throws(() => inspectAdapterBinding(sensitiveHookSpec, "judge"), /sensitive adapter file path/);

  const installedPluginHook = path.join(base, ".codex", "plugins", "wrapper.mjs");
  write(installedPluginHook, "export {};\n");
  const installedPluginSpec = path.join(base, "installed-plugin.json");
  writePrivateJson(installedPluginSpec, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, installedPluginHook], timeoutMs: 1000 });
  assert.equal(inspectAdapterBinding(installedPluginSpec, "judge").executableFingerprint.length, 2);

  const codexSessionHook = path.join(base, ".codex", "sessions", "hook.mjs");
  write(codexSessionHook, "export {};\n");
  const codexSessionSpec = path.join(base, "private-tree-adapter.json");
  writePrivateJson(codexSessionSpec, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, codexSessionHook], timeoutMs: 1000 });
  assert.throws(() => inspectAdapterBinding(codexSessionSpec, "judge"), /sensitive adapter file path/);

  const oversizedHookPath = path.join(base, "oversized-hook.cjs");
  write(oversizedHookPath, "");
  fs.truncateSync(oversizedHookPath, 128_000_001);
  const oversizedHookSpec = path.join(base, "oversized-hook.json");
  writePrivateJson(oversizedHookSpec, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, `--require=${oversizedHookPath}`, fakeAdapter], timeoutMs: 1000 });
  assert.throws(() => inspectAdapterBinding(oversizedHookSpec, "judge"), /fingerprint file exceeds/);

  const secretPath = path.join(base, "invalid-fields.json");
  writePrivateJson(secretPath, { schema: "contextlean.adapter/v1", role: "judge", argv: [process.execPath, fakeAdapter], timeoutMs: 1000, env: { API_KEY: "not-allowed" } });
  assert.throws(() => invokeAdapter(secretPath, "judge", { role: "judge" }), /unsupported field|must not contain environment variables or credentials/);

  const { base: runnerBase } = fixture();
  const receiptPath = path.join(runnerBase, "receipt.json");
  writePrivateJson(receiptPath, { schema: "contextlean.sandbox-receipt/v1", qualified: true, backend: "test", policySha256: "b".repeat(64) });
  const runnerPath = path.join(runnerBase, "runner.json");
  writePrivateJson(runnerPath, adapterSpec("runner", undefined, { path: receiptPath, sha256: "c".repeat(64) }));
  assert.throws(() => invokeAdapter(runnerPath, "runner", { role: "runner" }), /receipt hash mismatch/);

  const environmentPath = path.join(base, "environment.json");
  writePrivateJson(environmentPath, adapterSpec("judge", "env-check"));
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalLowerHttpProxy = process.env.http_proxy;
  process.env.CONTEXTLEAN_TEST_SECRET = "must-not-reach-adapter";
  process.env.HTTP_PROXY = "http://user:password@contextlean-proxy-sentinel.invalid:8080";
  process.env.http_proxy = "http://user:password@contextlean-proxy-sentinel.invalid:8080";
  try {
    const invoked = invokeAdapter(environmentPath, "judge", { role: "judge" });
    assert.equal(invoked.response.schema, "contextlean.judge-output/v1");
  } finally {
    delete process.env.CONTEXTLEAN_TEST_SECRET;
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
    if (originalLowerHttpProxy === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = originalLowerHttpProxy;
  }
});

test("public JSON Schemas compile and validate real persisted v0.2 artifacts", () => {
  const schemaDirectory = path.join(repositoryRoot, "plugins", "contextlean", "skills", "optimize-agent-context", "schemas");
  const names = fs.readdirSync(schemaDirectory).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [
    "adapter.schema.json",
    "candidate.schema.json",
    "context-pack.schema.json",
    "experiment.schema.json",
    "profile.schema.json",
    "result.schema.json",
    "sandbox-receipt.schema.json",
    "selection.schema.json",
    "snapshot.schema.json",
    "source-versions.schema.json",
    "tasks.schema.json",
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  const validators = new Map();
  for (const name of names) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDirectory, name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/contextlean\.dev\/schemas\//);
    validators.set(name, ajv.compile(schema));
  }

  const pipeline = runPipeline();
  const sourceContent = "# State\n- status: active\n";
  write(path.join(pipeline.root, "STATE.md"), sourceContent);
  const sourceVersions = { schema: "contextlean.source-versions/v1", versions: { state: "v1" } };
  const pack = {
    schema: "contextlean.context-pack/v1",
    packId: "schema-sample",
    projectId: "sample",
    permissionFingerprint: "read-only",
    humanReviewStatus: "candidate",
    canonicalSources: [{ id: "state", path: "STATE.md", sha256: hashValue(sourceContent), version: "v1" }],
    builder: { parserVersion: "lines-v1", contentSchemaVersion: "state-v1", promptSha256: hashValue("prompt") },
    tokenBudget: 100,
    chunks: [{ id: "state", sourceId: "state", startLine: 1, endLine: 2, contentSha256: hashValue("# State\n- status: active") }],
  };
  const artifacts = new Map([
    ["adapter.schema.json", adapterSpec("runner", undefined, pipeline.sandboxReceipt)],
    ["candidate.schema.json", pipeline.candidate],
    ["context-pack.schema.json", pack],
    ["experiment.schema.json", pipeline.experiment],
    ["profile.schema.json", JSON.parse(fs.readFileSync(profileFixture, "utf8"))],
    ["result.schema.json", pipeline.result],
    ["sandbox-receipt.schema.json", JSON.parse(fs.readFileSync(pipeline.sandboxReceipt.path, "utf8"))],
    ["selection.schema.json", pipeline.selection.report],
    ["snapshot.schema.json", pipeline.snapshot],
    ["source-versions.schema.json", sourceVersions],
    ["tasks.schema.json", JSON.parse(fs.readFileSync(tasksFixture, "utf8"))],
  ]);
  for (const [name, artifact] of artifacts) {
    const validate = validators.get(name);
    assert.equal(validate(artifact), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  }

  const invalidAdapter = { ...adapterSpec("judge"), env: { TOKEN: "forbidden" } };
  assert.equal(validators.get("adapter.schema.json")(invalidAdapter), false);
  const invalidAdapterPath = path.join(pipeline.base, "invalid-adapter.json");
  writePrivateJson(invalidAdapterPath, invalidAdapter);
  assert.throws(() => inspectAdapterBinding(invalidAdapterPath, "judge"), /unsupported field/);

  const invalidCandidate = structuredClone(pipeline.candidate);
  invalidCandidate.variants[0].id = "";
  delete invalidCandidate.candidateSha256;
  invalidCandidate.candidateSha256 = hashArtifact(invalidCandidate);
  assert.equal(validators.get("candidate.schema.json")(invalidCandidate), false);
  assert.throws(() => writeCandidates(invalidCandidate, path.join(pipeline.base, "invalid-candidate.json")), /Candidate id must be a non-empty string/);

  const invalidResult = structuredClone(pipeline.result);
  invalidResult.candidates[0].judgments[0].rationale = "raw rationale must not persist";
  delete invalidResult.resultSha256;
  invalidResult.resultSha256 = hashArtifact(invalidResult);
  assert.equal(validators.get("result.schema.json")(invalidResult), false);
  assert.throws(() => writeExperimentResult(invalidResult, path.join(pipeline.base, "invalid-result.json")), /Raw judge rationale|unsupported field: rationale/);

  const invalidProfile = structuredClone(artifacts.get("profile.schema.json"));
  invalidProfile.qualityGates.minInputTokenImprovementPct = 0;
  assert.equal(validators.get("profile.schema.json")(invalidProfile), false);
  const invalidProfilePath = path.join(pipeline.base, "invalid-profile.json");
  write(invalidProfilePath, `${JSON.stringify(invalidProfile)}\n`);
  assert.throws(() => initExperiment({ snapshotPath: pipeline.snapshotPath, tasksPath: tasksFixture, profilePath: invalidProfilePath, model: "gpt-5.6-sol", reasoning: "high" }), /at least 5 percent/);

  const invalidTasks = structuredClone(artifacts.get("tasks.schema.json"));
  invalidTasks.tasks[0].assertions.unknownEvaluator = true;
  assert.equal(validators.get("tasks.schema.json")(invalidTasks), false);
  const invalidTasksPath = path.join(pipeline.base, "invalid-tasks.json");
  write(invalidTasksPath, `${JSON.stringify(invalidTasks)}\n`);
  assert.throws(() => initExperiment({ snapshotPath: pipeline.snapshotPath, tasksPath: invalidTasksPath, profilePath: profileFixture, model: "gpt-5.6-sol", reasoning: "high" }), /unsupported assertion/);

  const invalidPack = structuredClone(pack);
  invalidPack.packId = "";
  assert.equal(validators.get("context-pack.schema.json")(invalidPack), false);
  const invalidPackPath = path.join(pipeline.base, "invalid-pack.json");
  writePrivateJson(invalidPackPath, invalidPack);
  const sourceVersionsPath = writeSourceVersions(pipeline.base, { state: "v1" });
  assert.throws(() => validateContextPack({
    manifestPath: invalidPackPath,
    sourceVersionsPath,
    root: pipeline.root,
    permissionFingerprint: "read-only",
    parserVersion: "lines-v1",
    contentSchemaVersion: "state-v1",
    promptSha256: hashValue("prompt"),
  }), /packId must be/);
});

test("candidate generation refuses credential-like target content before adapter execution", () => {
  const prepared = preparePipeline({ targetContent: "# Rules\napi_key = \"abcdefghijklmno\"\n" });
  assert.throws(() => generateCandidates({ experimentPath: prepared.experimentPath, adapterPath: prepared.optimizerPath, targetPath: prepared.target }), /credential-assignment/);
});

test("experiment initialization rejects zero gates and category gates weaker than the frozen task set", () => {
  const { base, root, home } = fixture();
  write(path.join(root, "AGENTS.md"), "# Rules\nKeep evidence current.\n");
  const snapshot = createSnapshot({ root, home, scope: "repo", auditReport: auditEnvironment({ root, home, scope: "repo" }) });
  const snapshotPath = path.join(base, "snapshot.json");
  writeSnapshot(snapshot, snapshotPath);
  const profile = JSON.parse(fs.readFileSync(smokeProfileFixture, "utf8"));
  profile.qualityGates.minBlindNetWins = 0;
  profile.qualityGates.minInputTokenImprovementPct = 0;
  const profilePath = path.join(base, "weak-profile.json");
  write(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  assert.throws(() => initExperiment({
    snapshotPath,
    tasksPath: smokeTasksFixture,
    profilePath,
    model: "gpt-5.6-sol",
    reasoning: "high",
    repetitions: 3,
  }), /positive|at least 5 percent/);

  const undercounted = JSON.parse(fs.readFileSync(smokeProfileFixture, "utf8"));
  undercounted.qualityGates.requiredCategoryPasses.instruction = 1;
  const undercountedPath = path.join(base, "undercounted-profile.json");
  write(undercountedPath, `${JSON.stringify(undercounted, null, 2)}\n`);
  assert.throws(() => initExperiment({
    snapshotPath,
    tasksPath: smokeTasksFixture,
    profilePath: undercountedPath,
    model: "gpt-5.6-sol",
    reasoning: "high",
    repetitions: 3,
  }), /require every instruction task/);
});

test("apply accepts a reviewed one-megabyte replacement even when JSON escaping exceeds two megabytes", () => {
  const { base, root } = fixture();
  const target = path.join(root, "AGENTS.md");
  const before = "# Before\n";
  const replacement = '"'.repeat(1_000_000);
  write(target, before);
  const plan = {
    schemaVersion: 1,
    root,
    operations: [{ type: "replace", path: "AGENTS.md", expectedSha256: hashValue(before), content: replacement }],
  };
  const planPath = path.join(base, "large-plan.json");
  write(planPath, `${JSON.stringify(plan)}\n`);
  assert.ok(fs.statSync(planPath).size > 2_000_000);
  const applied = applyPlan(planPath, { yes: true, root });
  assert.equal(fs.statSync(target).size, 1_000_000);
  const rolledBack = rollbackReceipt(applied.receiptPath, { yes: true, root });
  assert.equal(rolledBack.receipt.status, "rolled_back");
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("Context Packs render cited source ranges and fail closed after causal invalidation", () => {
  const { base, root } = fixture();
  const sourceContent = "# State\n- status: active\n- next: verify\n";
  const sourcePath = path.join(root, "STATE.md");
  write(sourcePath, sourceContent);
  const chunkContent = "# State\n- status: active\n- next: verify";
  const promptSha256 = hashValue("context-pack-prompt-v1");
  const manifest = {
    schema: "contextlean.context-pack/v1",
    packId: "state-sample",
    projectId: "sample-project",
    permissionFingerprint: "read-only-public-fixture-v1",
    humanReviewStatus: "candidate",
    canonicalSources: [{ id: "state", path: "STATE.md", sha256: hashValue(sourceContent), version: "v1" }],
    builder: { parserVersion: "lines-v1", contentSchemaVersion: "state-v1", promptSha256 },
    tokenBudget: 100,
    chunks: [{ id: "current-state", sourceId: "state", startLine: 1, endLine: 3, contentSha256: hashValue(chunkContent) }],
  };
  const manifestPath = path.join(base, "pack.json");
  writePrivateJson(manifestPath, manifest);
  const sourceVersionsPath = writeSourceVersions(base, { state: "v1" });
  const options = {
    manifestPath,
    sourceVersionsPath,
    root,
    permissionFingerprint: manifest.permissionFingerprint,
    parserVersion: manifest.builder.parserVersion,
    contentSchemaVersion: manifest.builder.contentSchemaVersion,
    promptSha256,
  };

  const validation = validateContextPack(options);
  assert.equal(validation.ok, true);
  assert.throws(() => renderContextPack(options), /explicit --allow-candidate/);
  const rendered = renderContextPack({ ...options, allowCandidate: true });
  assert.match(rendered.content, /STATE\.md#L1-L3/);
  assert.match(rendered.content, /canonical sources remain authoritative/);

  writePrivateJson(sourceVersionsPath, { schema: "contextlean.source-versions/v1", versions: { state: "v2" } }, { overwrite: true });
  const staleVersion = validateContextPack(options);
  assert.equal(staleVersion.ok, false);
  assert.ok(staleVersion.staleReasons.includes("source-version-changed:state"));
  writePrivateJson(sourceVersionsPath, { schema: "contextlean.source-versions/v1", versions: { state: "v1" } }, { overwrite: true });

  write(sourcePath, `${sourceContent}- changed: true\n`);
  const stale = validateContextPack(options);
  assert.equal(stale.ok, false);
  assert.ok(stale.staleReasons.includes("source-hash-changed:state"));
  assert.throws(() => renderContextPack({ ...options, allowCandidate: true }), /Context Pack is stale/);
});

test("Context Pack rendering refuses credential-like cited content", () => {
  const { base, root } = fixture();
  const sourceContent = "api_key = \"abcdefghijklmno\"\n";
  write(path.join(root, "STATE.md"), sourceContent);
  const promptSha256 = hashValue("prompt");
  const manifestPath = path.join(base, "content-guard-pack.json");
  writePrivateJson(manifestPath, {
    schema: "contextlean.context-pack/v1",
    packId: "secret",
    projectId: "sample",
    permissionFingerprint: "read-only",
    humanReviewStatus: "candidate",
    canonicalSources: [{ id: "state", path: "STATE.md", sha256: hashValue(sourceContent), version: "v1" }],
    builder: { parserVersion: "v1", contentSchemaVersion: "v1", promptSha256 },
    tokenBudget: 100,
    chunks: [{ id: "secret", sourceId: "state", startLine: 1, endLine: 1, contentSha256: hashValue(sourceContent.trimEnd()) }],
  });
  const sourceVersionsPath = writeSourceVersions(base, { state: "v1" });
  assert.throws(() => validateContextPack({
    manifestPath,
    sourceVersionsPath,
    root,
    permissionFingerprint: "read-only",
    parserVersion: "v1",
    contentSchemaVersion: "v1",
    promptSha256,
  }), /credential-assignment/);
});

test("Context Pack token budget covers final headers and citations, not only selected source text", () => {
  const { base, root } = fixture();
  const sourceContent = `${Array.from({ length: 20 }, () => "x").join("\n")}\n`;
  write(path.join(root, "STATE.md"), sourceContent);
  const promptSha256 = hashValue("prompt");
  const manifestPath = path.join(base, "overhead-pack.json");
  writePrivateJson(manifestPath, {
    schema: "contextlean.context-pack/v1",
    packId: "overhead",
    projectId: "sample",
    permissionFingerprint: "read-only",
    humanReviewStatus: "candidate",
    canonicalSources: [{ id: "state", path: "STATE.md", sha256: hashValue(sourceContent), version: "v1" }],
    builder: { parserVersion: "v1", contentSchemaVersion: "v1", promptSha256 },
    tokenBudget: 50,
    chunks: Array.from({ length: 20 }, (_, index) => ({
      id: `line-${index + 1}`,
      sourceId: "state",
      startLine: index + 1,
      endLine: index + 1,
      contentSha256: hashValue("x"),
    })),
  });
  const sourceVersionsPath = writeSourceVersions(base, { state: "v1" });
  const validation = validateContextPack({
    manifestPath,
    sourceVersionsPath,
    root,
    permissionFingerprint: "read-only",
    parserVersion: "v1",
    contentSchemaVersion: "v1",
    promptSha256,
  });
  assert.equal(validation.metrics.selectedContentBytes, 20);
  assert.ok(validation.metrics.renderedBytes > validation.metrics.selectedContentBytes);
  assert.ok(validation.staleReasons.includes("token-budget-exceeded"));
  assert.equal(validation.ok, false);
});

test("Context Pack validation refuses sensitive source path categories before reading", () => {
  for (const relativePath of [".env.development", ".envrc", ".claude/projects/private-thread.jsonl"]) {
    const { base, root } = fixture();
    const sourceContent = "NOT_A_REAL_SECRET=value\n";
    write(path.join(root, relativePath), sourceContent);
    const manifestPath = path.join(base, "sensitive-path-pack.json");
    writePrivateJson(manifestPath, {
      schema: "contextlean.context-pack/v1",
      packId: "sensitive-path",
      projectId: "sample",
      permissionFingerprint: "read-only",
      humanReviewStatus: "candidate",
      canonicalSources: [{ id: "state", path: relativePath, sha256: hashValue(sourceContent), version: "v1" }],
      builder: { parserVersion: "v1", contentSchemaVersion: "v1", promptSha256: hashValue("prompt") },
      tokenBudget: 100,
      chunks: [{ id: "value", sourceId: "state", startLine: 1, endLine: 1, contentSha256: hashValue(sourceContent.trimEnd()) }],
    });
    const sourceVersionsPath = writeSourceVersions(base, { state: "v1" });
    assert.throws(() => validateContextPack({
      manifestPath,
      sourceVersionsPath,
      root,
      permissionFingerprint: "read-only",
      parserVersion: "v1",
      contentSchemaVersion: "v1",
      promptSha256: hashValue("prompt"),
    }), /sensitive Context Pack source path/);
  }
});
