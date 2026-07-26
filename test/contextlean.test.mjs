import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyPlan,
  auditEnvironment,
  createPlan,
  rollbackReceipt,
  sha256File,
  verifyReceipt,
} from "../plugins/contextlean/skills/optimize-agent-context/scripts/contextlean.mjs";

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "contextlean-test-"));
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

test("plan and receipt readers reject sensitive paths before JSON handling", () => {
  const { base } = fixture();
  const envrcPlan = path.join(base, ".envrc");
  const transcriptReceipt = path.join(base, ".claude", "projects", "private-thread.json");
  write(envrcPlan, JSON.stringify({ schemaVersion: 1, operations: [] }));
  write(transcriptReceipt, JSON.stringify({ schemaVersion: 1, operations: [] }));

  assert.throws(() => applyPlan(envrcPlan, { yes: true }), /sensitive file path/);
  assert.throws(() => verifyReceipt(transcriptReceipt), /sensitive file path/);
  assert.throws(() => sha256File(envrcPlan), /sensitive file path/);
});

test("receipt readers reject parent symlinks into private agent trees", { skip: process.platform === "win32" }, () => {
  const { base, root } = fixture();
  const privateDirectory = path.join(base, ".claude", "projects");
  const privateReceipt = path.join(privateDirectory, "private-thread.json");
  const safeAlias = path.join(base, "reviewed-receipts");
  write(privateReceipt, JSON.stringify({ schemaVersion: 1, root, operations: [] }));
  fs.symlinkSync(privateDirectory, safeAlias, "dir");

  assert.throws(() => verifyReceipt(path.join(safeAlias, "private-thread.json")), /sensitive resolved file path/);
});

test("audit finds duplicate context, idle hooks, and cross-vendor keys without leaking values", () => {
  const { root, home } = fixture();
  const repeated = "Keep deterministic constraints in tests and schemas instead of repeating them in prompts.";
  write(path.join(root, "AGENTS.md"), `# Rules\n${repeated}\n`);
  write(path.join(root, "nested", "CLAUDE.md"), `# Rules\n${repeated}\n`);
  write(path.join(home, ".codex", "config.toml"), `[features]\nhooks = true\n\n[shell_environment_policy.set]\nCLAUDE_API_KEY = "never-print-this"\n`);
  write(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { OPENAI_API_KEY: "also-never-print" } }));

  const report = auditEnvironment({ root, home, scope: "all" });
  const serialized = JSON.stringify(report);
  const ids = report.findings.map((item) => item.id);

  assert.equal(report.metrics.instructionFiles, 2);
  assert.ok(ids.includes("duplicate-instruction-lines"));
  assert.ok(ids.includes("codex-idle-hooks"));
  assert.ok(ids.includes("codex-cross-vendor-env"));
  assert.ok(ids.includes("claude-cross-vendor-env"));
  assert.equal(serialized.includes("never-print-this"), false);
  assert.equal(serialized.includes("also-never-print"), false);
  assert.equal(report.privacy.sessionTranscriptsRead, false);
});

test("repo scope does not count personal skills or plugins", () => {
  const { root, home } = fixture();
  write(path.join(root, "AGENTS.md"), "# Repo\n");
  write(path.join(home, ".agents", "skills", "personal", "SKILL.md"), "---\nname: personal\ndescription: personal\n---\n");
  write(path.join(home, ".codex", "config.toml"), `[plugins."personal"]\nenabled = true\n`);

  const report = auditEnvironment({ root, home, scope: "repo" });

  assert.equal(report.metrics.discoveredSkills, 0);
  assert.equal(report.metrics.enabledPlugins, 0);
  assert.equal(report.homeInspected, false);
});

test("plan scaffold carries audit hashes but starts with no mutation", () => {
  const { root, home } = fixture();
  write(path.join(root, "AGENTS.md"), "# Rules\nKeep this concise.\n");
  const report = auditEnvironment({ root, home, scope: "repo" });
  const plan = createPlan(report);

  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.root, root);
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.auditSummary.metrics.instructionFiles, 1);
});

test("apply is hash-guarded, verifies, and rolls back exactly", () => {
  const { root, home } = fixture();
  const target = path.join(root, "AGENTS.md");
  const before = "# Rules\nOld rule.\n";
  const after = "# Rules\nNew measured rule.\n";
  write(target, before);
  const planPath = path.join(root, ".contextlean", "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{ type: "replace", path: "AGENTS.md", expectedSha256: sha256File(target), content: after }],
  }));

  const applied = applyPlan(planPath, { yes: true });
  assert.equal(fs.readFileSync(target, "utf8"), after);
  assert.equal(verifyReceipt(applied.receiptPath, { home }).ok, true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(applied.receiptPath).mode & 0o777, 0o600);
    const backupPath = path.join(root, applied.receipt.operations[0].backupPath);
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  }

  const rolledBack = rollbackReceipt(applied.receiptPath, { yes: true });
  assert.equal(rolledBack.receipt.status, "rolled_back");
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("apply refuses a stale plan", () => {
  const { root } = fixture();
  const target = path.join(root, "AGENTS.md");
  write(target, "# Current\n");
  const planPath = path.join(root, "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{ type: "replace", path: "AGENTS.md", expectedSha256: "0".repeat(64), content: "# Changed\n" }],
  }));

  assert.throws(() => applyPlan(planPath, { yes: true }), /Hash mismatch/);
  assert.equal(fs.readFileSync(target, "utf8"), "# Current\n");
});

test("apply refuses a mismatched optional replacement content hash", () => {
  const { root } = fixture();
  const target = path.join(root, "AGENTS.md");
  write(target, "# Current\n");
  const planPath = path.join(root, "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{
      type: "replace",
      path: "AGENTS.md",
      expectedSha256: sha256File(target),
      contentSha256: "0".repeat(64),
      content: "# Changed\n",
    }],
  }));

  assert.throws(() => applyPlan(planPath, { yes: true }), /content hash mismatch/);
  assert.equal(fs.readFileSync(target, "utf8"), "# Current\n");
});

test("apply refuses symlinks", { skip: process.platform === "win32" }, () => {
  const { root, base } = fixture();
  const outside = path.join(base, "outside.md");
  const link = path.join(root, "AGENTS.md");
  write(outside, "outside\n");
  fs.symlinkSync(outside, link);
  const planPath = path.join(root, "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{ type: "replace", path: "AGENTS.md", expectedSha256: sha256File(outside), content: "changed\n" }],
  }));

  assert.throws(() => applyPlan(planPath, { yes: true }), /symlink|regular file/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
});

test("apply refuses paths outside the plan root", () => {
  const { root, base } = fixture();
  const outside = path.join(base, "outside.md");
  write(outside, "outside\n");
  const planPath = path.join(root, "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{ type: "replace", path: "../outside.md", expectedSha256: sha256File(outside), content: "changed\n" }],
  }));

  assert.throws(() => applyPlan(planPath, { yes: true }), /escapes root/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
});

test("apply refuses arbitrary source files even with a matching hash", () => {
  const { root } = fixture();
  const target = path.join(root, "src", "app.js");
  write(target, "export const safe = true;\n");
  const planPath = path.join(root, "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{ type: "replace", path: "src/app.js", expectedSha256: sha256File(target), content: "malicious();\n" }],
  }));

  assert.throws(() => applyPlan(planPath, { yes: true }), /limited to known instruction files/);
  assert.equal(fs.readFileSync(target, "utf8"), "export const safe = true;\n");
});

test("apply refuses duplicate normalized targets", () => {
  const { root } = fixture();
  const target = path.join(root, "AGENTS.md");
  write(target, "# Rules\n");
  const digest = sha256File(target);
  const planPath = path.join(root, "plan.json");
  write(planPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [
      { type: "replace", path: "AGENTS.md", expectedSha256: digest, content: "# One\n" },
      { type: "replace", path: "./AGENTS.md", expectedSha256: digest, content: "# Two\n" },
    ],
  }));

  assert.throws(() => applyPlan(planPath, { yes: true }), /Duplicate operation path/);
  assert.equal(fs.readFileSync(target, "utf8"), "# Rules\n");
});

test("rollback refuses a forged backup location", () => {
  const { root } = fixture();
  const target = path.join(root, "AGENTS.md");
  const forgedBackup = path.join(root, "README.md");
  write(target, "# After\n");
  write(forgedBackup, "# Forged\n");
  const receiptPath = path.join(root, "receipt.json");
  write(receiptPath, JSON.stringify({
    schemaVersion: 1,
    root,
    operations: [{
      path: "AGENTS.md",
      beforeSha256: sha256File(forgedBackup),
      afterSha256: sha256File(target),
      backupPath: "README.md",
    }],
  }));

  assert.throws(() => rollbackReceipt(receiptPath, { yes: true }), /invalid backup path/);
  assert.equal(fs.readFileSync(target, "utf8"), "# After\n");
});
