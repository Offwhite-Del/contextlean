#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

const INSTRUCTION_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  "copilot-instructions.md",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".contextlean",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);
const NEVER_READ = new Set([
  "auth.json",
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
]);

class UsageError extends Error {}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readText(filePath, maxBytes = 2_000_000) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new UsageError(`Refusing non-regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new UsageError(`File exceeds ${maxBytes} byte safety limit: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function existingRegularFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && !NEVER_READ.has(path.basename(filePath).toLowerCase());
  } catch {
    return false;
  }
}

function walkInstructionFiles(root, maxDepth = 4) {
  const result = [];
  const seen = new Set();

  function visit(directory, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !INSTRUCTION_NAMES.has(entry.name)) continue;
      const resolved = path.resolve(fullPath);
      if (!seen.has(resolved) && existingRegularFile(resolved)) {
        seen.add(resolved);
        result.push(resolved);
      }
    }
  }

  visit(root, 0);
  return result.sort();
}

function countSkillFiles(directory, maxDepth = 5) {
  let count = 0;
  function visit(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") count += 1;
    }
  }
  visit(directory, 0);
  return count;
}

function fileRecord(filePath, root, kind) {
  const content = readText(filePath);
  const bytes = Buffer.byteLength(content);
  return {
    path: filePath,
    relativePath: path.relative(root, filePath) || path.basename(filePath),
    kind,
    bytes,
    lines: content === "" ? 0 : content.split(/\r?\n/).length,
    approximateTokens: Math.ceil(bytes / 4),
    sha256: sha256(content),
  };
}

function normalizedInstructionLines(filePath) {
  return readText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((line) => line.length >= 20 && !line.startsWith("#") && line !== "```");
}

function duplicateLineSummary(files) {
  const occurrences = new Map();
  for (const filePath of files) {
    const uniqueInFile = new Set(normalizedInstructionLines(filePath));
    for (const line of uniqueInFile) {
      if (!occurrences.has(line)) occurrences.set(line, []);
      occurrences.get(line).push(filePath);
    }
  }
  const duplicates = [...occurrences.values()].filter((paths) => paths.length > 1);
  return {
    exactDuplicateLineGroups: duplicates.length,
    affectedFiles: [...new Set(duplicates.flat())].sort(),
  };
}

function parseCodexConfig(configPath) {
  if (!existingRegularFile(configPath)) {
    return { enabledPlugins: 0, hooksEnabled: false, enabledHookStates: 0, crossVendorKeys: [] };
  }
  const raw = readText(configPath);
  const lines = raw.split(/\r?\n/);
  let inPlugin = false;
  let inHookState = false;
  let enabledPlugins = 0;
  let enabledHookStates = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inPlugin = /^\[plugins\./.test(trimmed);
      inHookState = /^\[hooks\.state\./.test(trimmed);
    } else if (/^enabled\s*=\s*true\s*$/.test(trimmed)) {
      if (inPlugin) enabledPlugins += 1;
      if (inHookState) enabledHookStates += 1;
    }
  }
  const hooksEnabled = /\[features\][\s\S]*?^hooks\s*=\s*true\s*$/m.test(raw);
  const crossVendorKeys = lines
    .map((line) => line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/)?.[1])
    .filter((key) => key && /^(ANTHROPIC_|CLAUDE_|DEEPSEEK_BASE_URL$)/.test(key));
  return { enabledPlugins, hooksEnabled, enabledHookStates, crossVendorKeys: [...new Set(crossVendorKeys)] };
}

function parseClaudeSettings(settingsPath) {
  if (!existingRegularFile(settingsPath)) {
    return { enabledPlugins: 0, hooksConfigured: false, crossVendorKeys: [], parseError: false };
  }
  try {
    const value = JSON.parse(readText(settingsPath));
    const enabledPlugins = Object.values(value.enabledPlugins || {}).filter(Boolean).length;
    const hooksConfigured = Boolean(value.hooks && Object.keys(value.hooks).length);
    const crossVendorKeys = Object.keys(value.env || {}).filter((key) => /^(OPENAI_|CODEX_)/.test(key));
    return { enabledPlugins, hooksConfigured, crossVendorKeys, parseError: false };
  } catch {
    return { enabledPlugins: 0, hooksConfigured: false, crossVendorKeys: [], parseError: true };
  }
}

function finding(id, severity, category, title, evidence, proposal) {
  return { id, severity, category, title, evidence, proposal };
}

export function auditEnvironment(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const scope = options.scope || "repo";
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new UsageError(`Root is not a directory: ${root}`);
  }
  if (!new Set(["repo", "home", "all"]).has(scope)) {
    throw new UsageError(`Invalid scope: ${scope}`);
  }

  const instructionFiles = [];
  if (scope === "repo" || scope === "all") instructionFiles.push(...walkInstructionFiles(root));
  if (scope === "home" || scope === "all") {
    for (const candidate of [path.join(home, ".codex", "AGENTS.md"), path.join(home, ".claude", "CLAUDE.md")]) {
      if (existingRegularFile(candidate)) instructionFiles.push(candidate);
    }
  }
  const uniqueFiles = [...new Set(instructionFiles.map((entry) => path.resolve(entry)))].sort();
  const files = uniqueFiles.map((filePath) => fileRecord(filePath, root, "instruction"));
  const totalInstructionBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const duplicateSummary = duplicateLineSummary(uniqueFiles);

  const codexConfigPaths = [];
  const claudeSettingsPaths = [];
  const skillDirectories = [];
  if (scope === "repo" || scope === "all") {
    codexConfigPaths.push(path.join(root, ".codex", "config.toml"));
    claudeSettingsPaths.push(path.join(root, ".claude", "settings.json"));
    skillDirectories.push(path.join(root, ".codex", "skills"), path.join(root, ".agents", "skills"), path.join(root, ".claude", "skills"));
  }
  if (scope === "home" || scope === "all") {
    codexConfigPaths.push(path.join(home, ".codex", "config.toml"));
    claudeSettingsPaths.push(path.join(home, ".claude", "settings.json"));
    skillDirectories.push(path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills"), path.join(home, ".claude", "skills"));
  }
  const codexConfigs = [...new Set(codexConfigPaths)].map(parseCodexConfig);
  const claudeSettingsList = [...new Set(claudeSettingsPaths)].map(parseClaudeSettings);
  const codexConfig = {
    enabledPlugins: codexConfigs.reduce((sum, item) => sum + item.enabledPlugins, 0),
    hooksEnabled: codexConfigs.some((item) => item.hooksEnabled),
    enabledHookStates: codexConfigs.reduce((sum, item) => sum + item.enabledHookStates, 0),
    crossVendorKeys: [...new Set(codexConfigs.flatMap((item) => item.crossVendorKeys))],
  };
  const claudeSettings = {
    enabledPlugins: claudeSettingsList.reduce((sum, item) => sum + item.enabledPlugins, 0),
    hooksConfigured: claudeSettingsList.some((item) => item.hooksConfigured),
    crossVendorKeys: [...new Set(claudeSettingsList.flatMap((item) => item.crossVendorKeys))],
    parseError: claudeSettingsList.some((item) => item.parseError),
  };
  const skillCount = [...new Set(skillDirectories)].reduce((sum, directory) => sum + countSkillFiles(directory), 0);
  const enabledPluginCount = codexConfig.enabledPlugins + claudeSettings.enabledPlugins;
  const findings = [];

  for (const file of files) {
    if (file.bytes > 8192) {
      findings.push(finding(
        `large-instruction-${sha256(file.path).slice(0, 8)}`,
        "high",
        "context",
        "Large always-on instruction file",
        `${file.relativePath} is ${file.bytes} bytes (~${file.approximateTokens} tokens by a rough bytes/4 estimate).`,
        "Measure representative tasks, then move task-specific detail into on-demand skills or references while preserving safety boundaries.",
      ));
    } else if (file.bytes > 4096) {
      findings.push(finding(
        `medium-instruction-${sha256(file.path).slice(0, 8)}`,
        "medium",
        "context",
        "Instruction file exceeds the review threshold",
        `${file.relativePath} is ${file.bytes} bytes. The 4096-byte threshold is a heuristic, not a quality limit.`,
        "Check for repeated history, examples, and deterministic rules that belong in tests or on-demand references.",
      ));
    }
  }
  if (totalInstructionBytes > 16384) {
    findings.push(finding(
      "total-context-budget-high",
      "high",
      "context",
      "Combined instruction footprint is high",
      `${totalInstructionBytes} bytes across ${files.length} instruction files.`,
      "Establish a measured context budget and reduce one category at a time with before/after evals.",
    ));
  }
  if (duplicateSummary.exactDuplicateLineGroups > 0) {
    findings.push(finding(
      "duplicate-instruction-lines",
      "medium",
      "context",
      "Exact instruction lines appear in multiple files",
      `${duplicateSummary.exactDuplicateLineGroups} duplicate groups affect ${duplicateSummary.affectedFiles.length} files; content is intentionally not printed.`,
      "Choose one authoritative location for each repeated rule and verify nested precedence before editing.",
    ));
  }
  if (skillCount > 100) {
    findings.push(finding("skill-metadata-high", "high", "skills", "Very large skill catalog", `${skillCount} SKILL.md files were discovered in user skill roots.`, "Disable or move unused catalogs only after checking discovery and task coverage."));
  } else if (skillCount > 30) {
    findings.push(finding("skill-metadata-medium", "medium", "skills", "Skill catalog deserves a relevance review", `${skillCount} SKILL.md files were discovered.`, "Keep high-frequency skills discoverable and load detailed references only on demand."));
  }
  if (enabledPluginCount > 8) {
    findings.push(finding("enabled-plugins-high", "medium", "plugins", "Many plugins are enabled", `${enabledPluginCount} enabled plugin entries were detected across supported configs.`, "Measure startup and representative tasks before disabling low-frequency plugins."));
  }
  if (codexConfig.hooksEnabled && codexConfig.enabledHookStates === 0) {
    findings.push(finding("codex-idle-hooks", "low", "hooks", "Codex hooks are globally enabled with no detected enabled hook state", "The global feature is on but no enabled hook state was found.", "Confirm runtime behavior, then consider disabling the global hook feature to remove idle startup work."));
  }
  if (codexConfig.crossVendorKeys.length) {
    findings.push(finding("codex-cross-vendor-env", "medium", "environment", "Claude or third-party variables are injected by Codex", `Detected key names: ${codexConfig.crossVendorKeys.join(", ")}. Values were not read into the report.`, "Confirm these variables are not needed by commands launched from Codex, then remove only the proven cross-vendor entries."));
  }
  if (claudeSettings.crossVendorKeys.length) {
    findings.push(finding("claude-cross-vendor-env", "medium", "environment", "OpenAI or Codex variables are injected by Claude Code", `Detected key names: ${claudeSettings.crossVendorKeys.join(", ")}. Values were not read into the report.`, "Confirm these variables are not needed by commands launched from Claude Code, then remove only the proven cross-vendor entries."));
  }
  if (claudeSettings.parseError) {
    findings.push(finding("claude-settings-invalid-json", "high", "configuration", "Claude settings JSON could not be parsed", "The file was inspected locally, but its contents were not included.", "Repair the JSON syntax before making optimization changes."));
  }

  return {
    schemaVersion: 1,
    tool: `contextlean/${VERSION}`,
    generatedAt: new Date().toISOString(),
    scope,
    root,
    homeInspected: scope === "home" || scope === "all",
    privacy: {
      sessionTranscriptsRead: false,
      authFilesRead: false,
      secretValuesIncluded: false,
    },
    files,
    metrics: {
      instructionFiles: files.length,
      totalInstructionBytes,
      approximateInstructionTokens: Math.ceil(totalInstructionBytes / 4),
      exactDuplicateLineGroups: duplicateSummary.exactDuplicateLineGroups,
      discoveredSkills: skillCount,
      enabledPlugins: enabledPluginCount,
    },
    findings,
  };
}

export function createPlan(report) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: `contextlean/${VERSION}`,
    root: report.root,
    auditSummary: {
      metrics: report.metrics,
      findingIds: report.findings.map((item) => item.id),
    },
    instructions: [
      "Add only reviewed replace operations.",
      "Use paths relative to root, copy sha256 from the audit, and preserve untestable safety boundaries.",
      "Do not place secrets or private session content in this plan. Keep the plan out of version control.",
    ],
    operations: [],
  };
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath === "" || path.isAbsolute(relativePath)) {
    throw new UsageError(`Operation path must be non-empty and relative: ${relativePath}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new UsageError(`Operation escapes root: ${relativePath}`);
  }
  let cursor = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new UsageError(`Refusing symlink path: ${relativePath}`);
    }
  }
  return target;
}

function allowedReplacementPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const base = path.posix.basename(normalized);
  return INSTRUCTION_NAMES.has(base) || base === "SKILL.md";
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.contextlean-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, content, { mode: fs.statSync(filePath).mode });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid JSON: ${filePath}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function applyPlan(planPath, options = {}) {
  if (!options.yes) throw new UsageError("Apply requires --yes after reviewing the complete plan.");
  const plan = readJson(path.resolve(planPath));
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.operations) || !plan.operations.length) {
    throw new UsageError("Plan must use schemaVersion 1 and contain at least one operation.");
  }
  const root = path.resolve(options.root || plan.root || process.cwd());
  const seenPaths = new Set();
  const prepared = plan.operations.map((operation) => {
    if (operation.type !== "replace" || typeof operation.content !== "string") {
      throw new UsageError("Version 0.1 supports replace operations with string content only.");
    }
    if (Buffer.byteLength(operation.content) > 1_000_000) {
      throw new UsageError(`Replacement exceeds 1 MB: ${operation.path}`);
    }
    const target = resolveInside(root, operation.path);
    if (!allowedReplacementPath(operation.path)) {
      throw new UsageError(`Replace is limited to known instruction files and SKILL.md in version 0.1: ${operation.path}`);
    }
    if (seenPaths.has(target)) throw new UsageError(`Duplicate operation path: ${operation.path}`);
    seenPaths.add(target);
    if (!existingRegularFile(target)) throw new UsageError(`Replace target is not a regular file: ${operation.path}`);
    const beforeHash = sha256File(target);
    if (beforeHash !== operation.expectedSha256) {
      throw new UsageError(`Hash mismatch for ${operation.path}; refusing stale plan.`);
    }
    return { operation, target, beforeHash, afterHash: sha256(operation.content) };
  });

  const id = timestamp();
  const backupRoot = path.join(root, ".contextlean", "backups", id);
  const receiptPath = path.join(backupRoot, "receipt.json");
  const withBackups = prepared.map((item) => {
    const backupPath = path.join(backupRoot, "files", item.operation.path);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(item.target, backupPath);
    return { ...item, backupPath };
  });
  const receiptFor = (status) => ({
    schemaVersion: 1,
    id,
    tool: `contextlean/${VERSION}`,
    status,
    root,
    createdAt: new Date().toISOString(),
    operations: withBackups.map((item) => ({
      type: "replace",
      path: item.operation.path,
      beforeSha256: item.beforeHash,
      afterSha256: item.afterHash,
      backupPath: path.relative(root, item.backupPath),
    })),
  });
  writeJson(receiptPath, receiptFor("prepared"));
  const written = [];
  try {
    for (const item of withBackups) {
      atomicWrite(item.target, item.operation.content);
      written.push(item);
      if (sha256File(item.target) !== item.afterHash) throw new Error(`Post-write hash mismatch: ${item.operation.path}`);
    }
  } catch (error) {
    for (const item of written.reverse()) fs.copyFileSync(item.backupPath, item.target);
    writeJson(receiptPath, { ...receiptFor("rolled_back_after_error"), error: error.message });
    throw error;
  }
  const receipt = receiptFor("applied");
  writeJson(receiptPath, receipt);
  return { receipt, receiptPath };
}

export function verifyReceipt(receiptPath, options = {}) {
  const receipt = readJson(path.resolve(receiptPath));
  const root = path.resolve(options.root || receipt.root);
  const checks = receipt.operations.map((operation) => {
    if (!allowedReplacementPath(operation.path)) throw new UsageError(`Receipt contains a disallowed path: ${operation.path}`);
    const target = resolveInside(root, operation.path);
    const actualSha256 = existingRegularFile(target) ? sha256File(target) : null;
    return { path: operation.path, ok: actualSha256 === operation.afterSha256, actualSha256 };
  });
  return { ok: checks.every((check) => check.ok), root, checks, audit: auditEnvironment({ root, home: options.home, scope: "repo" }) };
}

export function rollbackReceipt(receiptPath, options = {}) {
  if (!options.yes) throw new UsageError("Rollback requires --yes after reviewing the receipt.");
  const receipt = readJson(path.resolve(receiptPath));
  const root = path.resolve(options.root || receipt.root);
  const prepared = receipt.operations.map((operation) => {
    if (!allowedReplacementPath(operation.path)) throw new UsageError(`Receipt contains a disallowed path: ${operation.path}`);
    if (typeof operation.backupPath !== "string") throw new UsageError(`Receipt is missing a backup path: ${operation.path}`);
    const normalizedBackup = operation.backupPath.split(path.sep).join("/");
    const expectedSuffix = `/files/${operation.path.split(path.sep).join("/")}`;
    if (!normalizedBackup.startsWith(".contextlean/backups/") || !normalizedBackup.endsWith(expectedSuffix)) {
      throw new UsageError(`Receipt contains an invalid backup path: ${operation.path}`);
    }
    const target = resolveInside(root, operation.path);
    const backup = resolveInside(root, operation.backupPath);
    if (!existingRegularFile(target) || sha256File(target) !== operation.afterSha256) {
      throw new UsageError(`Current file changed after apply; refusing rollback: ${operation.path}`);
    }
    if (!existingRegularFile(backup) || sha256File(backup) !== operation.beforeSha256) {
      throw new UsageError(`Backup is missing or corrupt: ${operation.path}`);
    }
    return { operation, target, backup };
  });
  for (const item of prepared) atomicWrite(item.target, readText(item.backup));
  const rollbackPath = path.join(path.dirname(path.resolve(receiptPath)), `rollback-${timestamp()}.json`);
  const result = {
    schemaVersion: 1,
    tool: `contextlean/${VERSION}`,
    status: "rolled_back",
    root,
    sourceReceipt: path.resolve(receiptPath),
    createdAt: new Date().toISOString(),
    operations: prepared.map((item) => ({ path: item.operation.path, restoredSha256: item.operation.beforeSha256 })),
  };
  writeJson(rollbackPath, result);
  return { receipt: result, receiptPath: rollbackPath };
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split(/=(.*)/s, 2);
    if (["yes", "json", "strict"].includes(rawKey)) {
      options[rawKey] = true;
      continue;
    }
    const next = inline ?? argv[index + 1];
    if (next === undefined || (inline === undefined && next.startsWith("--"))) throw new UsageError(`Missing value for --${rawKey}`);
    options[rawKey] = next;
    if (inline === undefined) index += 1;
  }
  return { positional, options };
}

function printAudit(report) {
  console.log(`ContextLean ${VERSION}`);
  console.log(`Scope: ${report.scope}`);
  console.log(`Instructions: ${report.metrics.instructionFiles} files, ${report.metrics.totalInstructionBytes} bytes (~${report.metrics.approximateInstructionTokens} tokens)`);
  console.log(`Skills: ${report.metrics.discoveredSkills}; enabled plugins: ${report.metrics.enabledPlugins}`);
  console.log(`Privacy: no auth files, secret values, or session transcripts read`);
  if (!report.findings.length) {
    console.log("Findings: none at current heuristic thresholds");
    return;
  }
  console.log(`Findings: ${report.findings.length}`);
  for (const item of report.findings) console.log(`- [${item.severity}] ${item.id}: ${item.title}`);
}

function help() {
  console.log(`ContextLean ${VERSION}\n\nUsage:\n  contextlean audit [--root PATH] [--scope repo|home|all] [--json]\n  contextlean doctor [--root PATH] [--home PATH] [--json]\n  contextlean plan [--root PATH] [--scope repo|home|all] [--write FILE]\n  contextlean apply --plan FILE --yes [--root PATH]\n  contextlean verify --receipt FILE [--json]\n  contextlean rollback --receipt FILE --yes\n\nSafety:\n  Audit is read-only. Apply accepts hash-guarded replace operations only, creates backups,\n  and refuses source files, symlinks, stale plans, auth files, path escapes, and files over 1 MB.\n  Version 0.1 applies only to known instruction files and SKILL.md.`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { positional, options } = parseArguments(argv);
    const command = positional[0] || "help";
    if (["help", "--help", "-h"].includes(command)) return help();
    if (["version", "--version", "-v"].includes(command)) return console.log(VERSION);
    if (command === "audit" || command === "doctor" || command === "plan") {
      const report = auditEnvironment({
        root: options.root,
        home: options.home,
        scope: command === "doctor" ? "all" : options.scope || "repo",
      });
      if (command === "plan") {
        const plan = createPlan(report);
        if (options.write) {
          writeJson(path.resolve(options.write), plan);
          console.log(`Plan scaffold written: ${path.resolve(options.write)}`);
        } else console.log(JSON.stringify(plan, null, 2));
      } else if (options.json) console.log(JSON.stringify(report, null, 2));
      else printAudit(report);
      if (options.strict && report.findings.some((item) => item.severity === "high")) process.exitCode = 1;
      return;
    }
    if (command === "apply") {
      if (!options.plan) throw new UsageError("Apply requires --plan FILE.");
      const result = applyPlan(options.plan, { root: options.root, yes: options.yes });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Applied safely. Receipt: ${result.receiptPath}`);
      return;
    }
    if (command === "verify") {
      if (!options.receipt) throw new UsageError("Verify requires --receipt FILE.");
      const result = verifyReceipt(options.receipt, { root: options.root, home: options.home });
      console.log(options.json ? JSON.stringify(result, null, 2) : `${result.ok ? "OK" : "FAIL"}: verified ${result.checks.length} operation(s)`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "rollback") {
      if (!options.receipt) throw new UsageError("Rollback requires --receipt FILE.");
      const result = rollbackReceipt(options.receipt, { root: options.root, yes: options.yes });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Rollback complete. Receipt: ${result.receiptPath}`);
      return;
    }
    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`ContextLean error: ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) await main();
