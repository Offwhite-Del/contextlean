import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export const V2_VERSION = "0.2.0";

const SCHEMAS = Object.freeze({
  snapshot: "contextlean.snapshot/v2",
  tasks: "contextlean.tasks/v1",
  profile: "contextlean.profile/v1",
  adapter: "contextlean.adapter/v1",
  candidate: "contextlean.candidate/v1",
  experiment: "contextlean.experiment/v1",
  result: "contextlean.result/v1",
  contextPack: "contextlean.context-pack/v1",
  sourceVersions: "contextlean.source-versions/v1",
  selection: "contextlean.selection/v1",
});

const METRIC_KEYS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "toolCalls",
  "repeatedReads",
  "toolErrors",
  "retries",
  "latencyMs",
]);

const SIDE_EFFECT_KEYS = Object.freeze([
  "unauthorizedWrites",
  "privacyViolations",
  "networkNodeChanges",
  "safetyViolations",
]);

const MAX_JSON_ARTIFACT_BYTES = 8_000_000;
const MAX_SELECTED_TEXT_BYTES = 1_000_000;
const MAX_CANONICAL_SOURCE_BYTES = 64_000_000;
const MAX_FINGERPRINT_FILE_BYTES = 128_000_000;
const DISALLOWED_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const ASSERTION_KEYS = new Set([
  "success",
  "outputEquals",
  "outputIncludes",
  "outputExcludes",
  "exactToolCalls",
  "maxToolCalls",
  "maxRepeatedReads",
  "sideEffectsZero",
  "jsonFileLineCitations",
]);

const ALLOWED_TARGET_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  "copilot-instructions.md",
  "SKILL.md",
]);

const NEVER_READ = new Set(["auth.json", "credentials.json"]);

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

const EXECUTABLE_FINGERPRINT_CACHE = new Map();

export class OptimizationUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function fail(message) {
  throw new OptimizationUsageError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertOnlyKeys(value, allowedKeys, label) {
  assert(isObject(value), `${label} must be an object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) assert(allowed.has(key), `${label} contains unsupported field: ${key}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string.`);
}

function assertSha256(value, label) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${label} must be a lowercase SHA-256 digest.`);
}

export function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hashObject(value) {
  return hashValue(stableStringify(value));
}

export function hashArtifact(value) {
  return hashObject(value);
}

function timestamp() {
  return new Date().toISOString();
}

function isSensitiveBasename(value) {
  const basename = value.toLowerCase();
  return NEVER_READ.has(basename) || basename === ".env" || basename.startsWith(".env.");
}

function sensitivePathFinding(filePath, options = {}) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) || "";
  const sensitiveDirectories = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".chatgpt", "keychains"]);
  if (options.blockAgentRoots !== false) {
    sensitiveDirectories.add(".claude");
    sensitiveDirectories.add(".codex");
  }
  const privateAgentTree = segments.some((segment, index) => (
    (segment === ".codex" && ["sessions", "history", "logs"].includes(segments[index + 1]))
    || (segment === ".claude" && ["projects", "sessions", "history", "logs"].includes(segments[index + 1]))
  ));
  const sensitiveSegment = segments.find((segment) => (
    segment === ".env"
    || segment.startsWith(".env.")
    || segment === ".envrc"
    || [".netrc", ".npmrc", ".pypirc"].includes(segment)
    || sensitiveDirectories.has(segment)
    || /(?:^|[._-])(?:auth|authentication|credentials?|secrets?|tokens?|sessions?|transcripts?|conversations?|chats?)(?:[._-]|$)/.test(segment)
  ));
  const privateKeyName = /^(?:id_rsa|id_ed25519|private[_-]?key)(?:\.|$)/.test(basename);
  const sensitiveExtension = /\.(?:key|pem|p12|pfx|cer|crt|der|jks)$/.test(basename);
  return sensitiveSegment || privateAgentTree || privateKeyName || sensitiveExtension ? "sensitive-path-category" : null;
}

function resolveSafeRegularRead(filePath, maxBytes = Number.POSITIVE_INFINITY) {
  const requested = path.resolve(filePath);
  assert(!sensitivePathFinding(requested, { blockAgentRoots: false }), `Refusing sensitive file path: ${filePath}`);
  let requestedStat;
  let resolved;
  let resolvedStat;
  try {
    requestedStat = fs.lstatSync(requested);
    resolved = fs.realpathSync(requested);
    resolvedStat = fs.statSync(resolved);
  } catch (error) {
    if (error instanceof OptimizationUsageError) throw error;
    fail(`Refusing non-regular, sensitive, or missing file: ${filePath}`);
  }
  assert(requestedStat.isFile() && !requestedStat.isSymbolicLink(), `Refusing non-regular, sensitive, or missing file: ${filePath}`);
  assert(!isSensitiveBasename(path.basename(requested)), `Refusing sensitive file path: ${filePath}`);
  assert(!sensitivePathFinding(resolved, { blockAgentRoots: false }), `Refusing sensitive resolved file path: ${filePath}`);
  assert(resolvedStat.isFile(), `Refusing non-regular, sensitive, or missing file: ${filePath}`);
  assert(resolvedStat.size <= maxBytes, `File exceeds ${maxBytes} byte safety limit: ${filePath}`);
  return { resolved, stat: resolvedStat };
}

function existingRegularFile(filePath) {
  try {
    resolveSafeRegularRead(filePath);
    return true;
  } catch {
    return false;
  }
}

function argumentFileCandidate(argument, index) {
  if (index === 0 || path.isAbsolute(argument)) return argument;
  const equalIndex = argument.indexOf("=");
  if (argument.startsWith("--") && equalIndex !== -1) return argument.slice(equalIndex + 1);
  const attachedShort = argument.match(/^-(?:r|C)(.+)$/);
  if (attachedShort) return attachedShort[1];
  const colonAttached = argument.match(/^-{1,2}[^:=]+:(.+)$/);
  if (colonAttached) return colonAttached[1];
  if (argument.startsWith("@") && argument.length > 1) return argument.slice(1);
  return argument.startsWith("-") ? null : argument;
}

function normalizeFileCandidate(value) {
  if (value?.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      fail(`Adapter file URL is invalid: ${value}`);
    }
  }
  return value;
}

function adapterFileArguments(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const rawCandidate = argumentFileCandidate(argument, index);
    if (rawCandidate === null && (/[\\/]/.test(argument) || /\.(?:[cm]?[jt]s|py|sh|bash|zsh|rb|pl|jar|exe|cmd|bat|ps1|wasm|so|dylib|dll|node)(?:$|[=:])/i.test(argument))) {
      fail(`Unrecognized file-like adapter argument; use an absolute standalone or flag value path: ${argument}`);
    }
    const candidate = normalizeFileCandidate(rawCandidate);
    const looksLikeFile = candidate !== null && (
      index === 0
      || path.isAbsolute(candidate)
      || /[\\/]/.test(candidate)
      || /\.(?:[cm]?[jt]s|py|sh|bash|zsh|rb|pl|jar|exe|cmd|bat|ps1|wasm|so|dylib|dll|node)$/i.test(candidate)
      || existingRegularFile(path.resolve(candidate))
    );
    if (!looksLikeFile) continue;
    assert(path.isAbsolute(candidate), `Adapter file arguments must be absolute paths: ${candidate}`);
    let resolved;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      fail(`Adapter file argument must resolve to a regular non-sensitive file: ${candidate}`);
    }
    const stat = fs.statSync(resolved);
    assert(stat.isFile(), `Adapter file argument must resolve to a regular non-sensitive file: ${candidate}`);
    assert(!sensitivePathFinding(candidate, { blockAgentRoots: false }) && !sensitivePathFinding(resolved, { blockAgentRoots: false }), `Refusing sensitive adapter file path: ${candidate}`);
    if (index > 0) {
      const codeLike = /\.(?:[cm]?[jt]s|py|sh|bash|zsh|rb|pl|jar|exe|cmd|bat|ps1|wasm|so|dylib|dll|node)$/i.test(resolved) || (stat.mode & 0o111) !== 0;
      assert(codeLike, `Adapter file arguments after argv[0] must be reviewed code or executable files: ${candidate}`);
    }
    assert(stat.size <= MAX_FINGERPRINT_FILE_BYTES, `Adapter fingerprint file exceeds ${MAX_FINGERPRINT_FILE_BYTES} bytes: ${candidate}`);
    files.push({ argvIndex: index, filePath: resolved });
  }
  return files;
}

function hashFileStreaming(filePath) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

function executableFingerprint(argv) {
  const files = [];
  for (const { argvIndex, filePath: resolved } of adapterFileArguments(argv)) {
    const stat = fs.statSync(resolved);
    const cacheKey = `${resolved}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let sha256 = EXECUTABLE_FINGERPRINT_CACHE.get(cacheKey);
    if (!sha256) {
      sha256 = hashFileStreaming(resolved);
      EXECUTABLE_FINGERPRINT_CACHE.set(cacheKey, sha256);
    }
    files.push({ argvIndex, sha256 });
  }
  return files;
}

function readText(filePath, maxBytes = 2_000_000) {
  const safeFile = resolveSafeRegularRead(filePath, maxBytes);
  return fs.readFileSync(safeFile.resolved, "utf8");
}

function readPrivateJsonArtifact(filePath, maxBytes = MAX_JSON_ARTIFACT_BYTES) {
  const resolved = path.resolve(filePath);
  let raw;
  try {
    raw = readText(resolved, maxBytes);
    return { value: JSON.parse(raw), sha256: hashValue(raw), path: resolved };
  } catch (error) {
    if (error instanceof OptimizationUsageError) throw error;
    fail(`Invalid JSON: ${filePath}`);
  }
}

export function readPrivateJson(filePath, maxBytes = MAX_JSON_ARTIFACT_BYTES) {
  return readPrivateJsonArtifact(filePath, maxBytes).value;
}

function assertPlainText(content, label) {
  assert(typeof content === "string", `${label} must be text.`);
  assert(!DISALLOWED_TEXT_CONTROLS.test(content), `${label} contains unsupported control characters.`);
}

export function writePrivateJson(filePath, value, options = {}) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const flag = options.overwrite ? "w" : "wx";
  try {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag });
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail(`Refusing to overwrite existing artifact: ${target}`);
    throw error;
  }
  return target;
}

function writePrivateText(filePath, value, options = {}) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const flag = options.overwrite ? "w" : "wx";
  try {
    fs.writeFileSync(target, value, { mode: 0o600, flag });
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail(`Refusing to overwrite existing artifact: ${target}`);
    throw error;
  }
  return target;
}

function fileSha256(filePath) {
  assert(existingRegularFile(filePath), `Refusing to hash non-regular or sensitive file: ${filePath}`);
  return hashValue(fs.readFileSync(filePath));
}

function resolveInside(root, relativePath) {
  assertString(relativePath, "Relative path");
  assert(!path.isAbsolute(relativePath), `Path must be relative to root: ${relativePath}`);
  const base = path.resolve(root);
  const target = path.resolve(base, relativePath);
  assert(target === base || target.startsWith(`${base}${path.sep}`), `Path escapes root: ${relativePath}`);
  let cursor = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`Refusing symlink path: ${relativePath}`);
  }
  return target;
}

function assertPortableRelativeFilePath(relativePath, label) {
  assertString(relativePath, label);
  assert(!path.isAbsolute(relativePath), `${label} must be relative.`);
  assert(!relativePath.includes("\\") && !relativePath.includes(":"), `${label} must use portable forward-slash segments.`);
  const segments = relativePath.split("/");
  assert(segments.length > 0 && segments.every((segment) => segment && segment !== "." && segment !== ".."), `${label} contains a non-canonical path segment.`);
}

function hasVisibleText(value) {
  return value.replace(/[\p{White_Space}\p{Cf}]/gu, "").length > 0;
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function boundedWalk(root, predicate, maxDepth = 6) {
  const result = [];
  function visit(directory, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(fullPath, depth + 1);
      } else if (entry.isFile() && predicate(entry.name, fullPath)) {
        result.push(path.resolve(fullPath));
      }
    }
  }
  if (fs.existsSync(root)) visit(path.resolve(root), 0);
  return result.sort();
}

function skillParts(filePath) {
  const content = readText(filePath);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = match?.[0] || "";
  const body = match ? content.slice(frontmatter.length) : content;
  const metadata = match?.[1] || "";
  const name = metadata.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || path.basename(path.dirname(filePath));
  const description = metadata.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || "";
  return { content, frontmatter, body, name, descriptionBytes: Buffer.byteLength(description) };
}

function surfaceBase(filePath, root, kind, loadMode, mutability, bytes, sha256) {
  const relativePath = pathInside(root, filePath) ? path.relative(root, filePath) : null;
  return {
    id: `${kind}-${hashValue(`${kind}:${filePath}:${loadMode}`).slice(0, 12)}`,
    kind,
    loadMode,
    mutability,
    path: path.resolve(filePath),
    relativePath,
    sha256,
    bytes,
    approximateTokens: Math.ceil(bytes / 4),
    evidence: "local-file-metadata-and-hash",
    contentIncluded: false,
  };
}

function deduplicatePaths(paths) {
  return [...new Set(paths.map((item) => path.resolve(item)))].sort();
}

function snapshotSkillPaths(root, home, scope) {
  const paths = [];
  if (scope === "repo" || scope === "all") {
    paths.push(...boundedWalk(root, (name) => name === "SKILL.md"));
  }
  if (scope === "home" || scope === "all") {
    for (const directory of [
      path.join(home, ".codex", "skills"),
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
    ]) {
      paths.push(...boundedWalk(directory, (name) => name === "SKILL.md", 5));
    }
  }
  return deduplicatePaths(paths);
}

function snapshotConfigurationPaths(root, home, scope) {
  const paths = [];
  if (scope === "repo" || scope === "all") {
    paths.push(path.join(root, ".codex", "config.toml"), path.join(root, ".claude", "settings.json"));
  }
  if (scope === "home" || scope === "all") {
    paths.push(path.join(home, ".codex", "config.toml"), path.join(home, ".claude", "settings.json"));
  }
  return deduplicatePaths(paths).filter(existingRegularFile);
}

export function createSnapshot(options = {}) {
  const auditReport = options.auditReport;
  assert(isObject(auditReport) && auditReport.schemaVersion === 1, "Snapshot requires a ContextLean audit report.");
  const root = path.resolve(options.root || auditReport.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const scope = options.scope || auditReport.scope || "repo";
  assert(["repo", "home", "all"].includes(scope), `Invalid snapshot scope: ${scope}`);
  const surfaces = [];

  for (const file of auditReport.files || []) {
    const global = file.path === path.join(home, ".codex", "AGENTS.md") || file.path === path.join(home, ".claude", "CLAUDE.md");
    surfaces.push({
      ...surfaceBase(file.path, root, global ? "global_instruction" : "project_instruction", "always_on", "reviewed_replace", file.bytes, file.sha256),
      lines: file.lines,
    });
  }

  for (const skillPath of snapshotSkillPaths(root, home, scope)) {
    const parts = skillParts(skillPath);
    const digest = hashValue(parts.content);
    surfaces.push({
      ...surfaceBase(skillPath, root, "skill_metadata", "automatic_metadata", "reviewed_replace", Buffer.byteLength(parts.frontmatter), digest),
      skillName: parts.name,
      descriptionBytes: parts.descriptionBytes,
    });
    surfaces.push({
      ...surfaceBase(skillPath, root, "skill_body", "on_demand", "reviewed_replace", Buffer.byteLength(parts.body), digest),
      skillName: parts.name,
    });
  }

  for (const configPath of snapshotConfigurationPaths(root, home, scope)) {
    const stat = fs.statSync(configPath);
    surfaces.push(surfaceBase(configPath, root, "configuration", "runtime", "advisory_only", stat.size, fileSha256(configPath)));
  }

  const packDirectory = path.join(root, ".contextlean", "packs");
  for (const manifestPath of boundedWalk(packDirectory, (name) => name.endsWith(".json"), 2)) {
    const stat = fs.statSync(manifestPath);
    surfaces.push(surfaceBase(manifestPath, root, "context_pack_manifest", "on_demand", "derived_cache", stat.size, fileSha256(manifestPath)));
  }

  surfaces.push({
    id: "account-custom-instructions",
    kind: "account_custom_instructions",
    loadMode: "account",
    mutability: "external_write_gate",
    observed: false,
    evidence: "not-provided-to-local-cli",
    contentIncluded: false,
  });
  surfaces.push({
    id: "provider-fixed-context",
    kind: "fixed_context",
    loadMode: "fixed",
    mutability: "uncontrollable",
    observed: false,
    evidence: "measurable-only-through-agent-usage",
    contentIncluded: false,
  });

  surfaces.sort((left, right) => left.id.localeCompare(right.id));
  const snapshot = {
    schema: SCHEMAS.snapshot,
    generatedAt: timestamp(),
    tool: `contextlean/${V2_VERSION}`,
    root,
    scope,
    auditSha256: hashObject(auditReport),
    surfaces,
    metrics: {
      surfaceCount: surfaces.length,
      alwaysOnBytes: surfaces.filter((item) => item.loadMode === "always_on").reduce((sum, item) => sum + (item.bytes || 0), 0),
      automaticMetadataBytes: surfaces.filter((item) => item.loadMode === "automatic_metadata").reduce((sum, item) => sum + (item.bytes || 0), 0),
      onDemandBytes: surfaces.filter((item) => item.loadMode === "on_demand").reduce((sum, item) => sum + (item.bytes || 0), 0),
    },
    privacy: {
      contentIncluded: false,
      authFilesRead: false,
      envFilesRead: false,
      sessionTranscriptsRead: false,
      secretValuesIncluded: false,
    },
  };
  snapshot.snapshotSha256 = hashObject(snapshot);
  return snapshot;
}

function validateSnapshot(snapshot) {
  assert(isObject(snapshot) && snapshot.schema === SCHEMAS.snapshot, `Expected ${SCHEMAS.snapshot}.`);
  assertSha256(snapshot.snapshotSha256, "snapshotSha256");
  const copy = { ...snapshot };
  delete copy.snapshotSha256;
  assert(hashObject(copy) === snapshot.snapshotSha256, "Snapshot self-hash mismatch.");
  assert(Array.isArray(snapshot.surfaces), "Snapshot surfaces must be an array.");
  assert(snapshot.privacy?.contentIncluded === false, "Snapshot must not include file contents.");
  return snapshot;
}

function validateTasks(tasks, options = {}) {
  assert(isObject(tasks) && tasks.schema === SCHEMAS.tasks, `Expected ${SCHEMAS.tasks}.`);
  assertOnlyKeys(tasks, ["schema", "tasks"], "Tasks manifest");
  assert(Array.isArray(tasks.tasks) && tasks.tasks.length > 0, "Tasks manifest must contain tasks.");
  const ids = new Set();
  for (const task of tasks.tasks) {
    const allowedTaskKeys = ["id", "category", "prompt", "dataClass", "heldOut", "allowedTools", "assertions", "rubric", "measureLatency"];
    if (options.allowTaskSha256) allowedTaskKeys.push("taskSha256");
    assertOnlyKeys(task, allowedTaskKeys, `Task ${task.id || "<unknown>"}`);
    assertString(task.id, "Task id");
    assert(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(task.id), `Task id is invalid: ${task.id}`);
    assert(!ids.has(task.id), `Duplicate task id: ${task.id}`);
    ids.add(task.id);
    assertString(task.category, `Task ${task.id} category`);
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task.category), `Task ${task.id} category is invalid.`);
    assertString(task.prompt, `Task ${task.id} prompt`);
    assertPlainText(task.prompt, `Task ${task.id} prompt`);
    assert(Buffer.byteLength(task.prompt) <= 50_000, `Task ${task.id} prompt exceeds 50 KB.`);
    assertNoSensitiveText(task.prompt, `Task ${task.id} prompt`);
    assert(task.dataClass === "non_sensitive", `Task ${task.id} must be explicitly non_sensitive in v0.2.`);
    assert(typeof task.heldOut === "boolean", `Task ${task.id} heldOut must be boolean.`);
    assert(Array.isArray(task.allowedTools) && task.allowedTools.every((tool) => typeof tool === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(tool)), `Task ${task.id} allowedTools must contain safe tool identifiers.`);
    assert(isObject(task.assertions), `Task ${task.id} assertions must be an object.`);
    const assertionKeys = Object.keys(task.assertions);
    assert(assertionKeys.length > 0, `Task ${task.id} must contain deterministic assertions.`);
    for (const key of assertionKeys) assert(ASSERTION_KEYS.has(key), `Task ${task.id} has unsupported assertion: ${key}`);
    const hasOutputAssertion = task.assertions.outputEquals !== undefined
      || (Array.isArray(task.assertions.outputIncludes) && task.assertions.outputIncludes.length > 0)
      || (Array.isArray(task.assertions.outputExcludes) && task.assertions.outputExcludes.length > 0)
      || task.assertions.jsonFileLineCitations !== undefined;
    assert(hasOutputAssertion, `Task ${task.id} must include at least one output assertion.`);
    if (task.assertions.success !== undefined) assert(typeof task.assertions.success === "boolean", `Task ${task.id} success assertion must be boolean.`);
    if (task.assertions.outputEquals !== undefined) {
      assert(typeof task.assertions.outputEquals === "string", `Task ${task.id} outputEquals must be a string.`);
      assertNoSensitiveText(task.assertions.outputEquals, `Task ${task.id} outputEquals`);
    }
    for (const key of ["outputIncludes", "outputExcludes"]) {
      if (task.assertions[key] !== undefined) {
        assert(Array.isArray(task.assertions[key]) && task.assertions[key].every((value) => typeof value === "string" && value.length > 0), `Task ${task.id} ${key} must be a non-empty string array.`);
        for (const value of task.assertions[key]) assertNoSensitiveText(value, `Task ${task.id} ${key}`);
      }
    }
    for (const key of ["exactToolCalls", "maxToolCalls", "maxRepeatedReads"]) {
      if (task.assertions[key] !== undefined) assert(Number.isInteger(task.assertions[key]) && task.assertions[key] >= 0, `Task ${task.id} ${key} must be a non-negative integer.`);
    }
    if (task.assertions.sideEffectsZero !== undefined) assert(typeof task.assertions.sideEffectsZero === "boolean", `Task ${task.id} sideEffectsZero must be boolean.`);
    if (task.assertions.jsonFileLineCitations !== undefined) {
      const citation = task.assertions.jsonFileLineCitations;
      assert(isObject(citation), `Task ${task.id} jsonFileLineCitations must be an object.`);
      assertOnlyKeys(citation, ["jsonField", "citationField", "minItems", "sources"], `Task ${task.id} jsonFileLineCitations`);
      for (const key of ["jsonField", "citationField"]) {
        assertString(citation[key], `Task ${task.id} jsonFileLineCitations.${key}`);
        assert(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(citation[key]), `Task ${task.id} jsonFileLineCitations.${key} is invalid.`);
      }
      assert(Number.isInteger(citation.minItems) && citation.minItems >= 1 && citation.minItems <= 1_000, `Task ${task.id} jsonFileLineCitations.minItems must be an integer from 1 to 1000.`);
      assert(Array.isArray(citation.sources) && citation.sources.length >= 1 && citation.sources.length <= 64, `Task ${task.id} jsonFileLineCitations.sources must contain 1 to 64 files.`);
      assertString(options.tasksRoot, `Task ${task.id} citation task root`);
      const sourcePaths = new Set();
      for (const source of citation.sources) {
        assertOnlyKeys(source, ["path", "sha256"], `Task ${task.id} citation source`);
        assertString(source.path, `Task ${task.id} citation source path`);
        assert(source.path.length <= 512, `Task ${task.id} citation source path exceeds 512 characters.`);
        assertPortableRelativeFilePath(source.path, `Task ${task.id} citation source path`);
        assertSafeCanonicalSourcePath(source.path);
        assertSha256(source.sha256, `Task ${task.id} citation source SHA-256`);
        assert(!sourcePaths.has(source.path), `Task ${task.id} has duplicate citation source: ${source.path}`);
        sourcePaths.add(source.path);
        const sourcePath = resolveInside(options.tasksRoot, source.path);
        const safeSource = resolveSafeRegularRead(sourcePath, MAX_CANONICAL_SOURCE_BYTES);
        const inspected = inspectSourceRanges(safeSource.resolved, []);
        assert(inspected.sha256 === source.sha256, `Task ${task.id} citation source hash changed: ${source.path}`);
      }
    }
    if (task.rubric !== undefined) {
      assertString(task.rubric, `Task ${task.id} rubric`);
      assertPlainText(task.rubric, `Task ${task.id} rubric`);
      assert(Buffer.byteLength(task.rubric) <= 20_000, `Task ${task.id} rubric exceeds 20 KB.`);
      assertNoSensitiveText(task.rubric, `Task ${task.id} rubric`);
    }
    if (task.measureLatency !== undefined) assert(typeof task.measureLatency === "boolean", `Task ${task.id} measureLatency must be boolean.`);
  }
  return tasks;
}

function validateProfile(profile) {
  assert(isObject(profile) && profile.schema === SCHEMAS.profile, `Expected ${SCHEMAS.profile}.`);
  assertOnlyKeys(profile, ["schema", "invariants", "objectives", "qualityGates"], "Profile");
  assert(Array.isArray(profile.invariants) && profile.invariants.length > 0, "Profile must define invariants.");
  const invariantIds = new Set();
  for (const invariant of profile.invariants) {
    assertOnlyKeys(invariant, ["id", "description"], "Invariant");
    assertString(invariant.id, "Invariant id");
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(invariant.id), `Invariant id is invalid: ${invariant.id}`);
    assertString(invariant.description, `Invariant ${invariant.id} description`);
    assertPlainText(invariant.description, `Invariant ${invariant.id} description`);
    assert(Buffer.byteLength(invariant.description) <= 2_000, `Invariant ${invariant.id} description exceeds 2 KB.`);
    assertNoSensitiveText(invariant.description, `Invariant ${invariant.id} description`);
    assert(!invariantIds.has(invariant.id), `Duplicate invariant id: ${invariant.id}`);
    invariantIds.add(invariant.id);
  }
  if (profile.objectives !== undefined) {
    assert(Array.isArray(profile.objectives), "Profile objectives must be an array.");
    for (const objective of profile.objectives) {
      assertString(objective, "Profile objective");
      assertPlainText(objective, "Profile objective");
      assert(Buffer.byteLength(objective) <= 2_000, "Profile objective exceeds 2 KB.");
      assertNoSensitiveText(objective, "Profile objective");
    }
  }
  const gates = profile.qualityGates;
  assert(isObject(gates), "Profile qualityGates must be an object.");
  assertOnlyKeys(gates, ["requiredCategoryPasses", "minBlindNonInferior", "maxBlindLosses", "minBlindNetWins", "minInputTokenImprovementPct", "minToolImprovementPct", "minLatencyImprovementPct", "maxOtherRegressionPct"], "Profile qualityGates");
  assert(isObject(gates.requiredCategoryPasses), "qualityGates.requiredCategoryPasses must be an object.");
  assert(Object.keys(gates.requiredCategoryPasses).length > 0, "qualityGates.requiredCategoryPasses must not be empty.");
  for (const [category, count] of Object.entries(gates.requiredCategoryPasses)) {
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(category), `Required category name is invalid: ${category}`);
    assert(Number.isInteger(count) && count > 0, `Required category count must be a positive integer: ${category}`);
  }
  for (const key of [
    "minBlindNonInferior",
    "maxBlindLosses",
    "minBlindNetWins",
    "minInputTokenImprovementPct",
    "minToolImprovementPct",
    "minLatencyImprovementPct",
    "maxOtherRegressionPct",
  ]) {
    assert(typeof gates[key] === "number" && gates[key] >= 0, `qualityGates.${key} must be a non-negative number.`);
  }
  assert(gates.minBlindNonInferior > 0, "qualityGates.minBlindNonInferior must be positive.");
  assert(gates.minBlindNetWins > 0, "qualityGates.minBlindNetWins must be positive.");
  assert(gates.minInputTokenImprovementPct >= 5, "Input-token improvement threshold must be at least 5 percent.");
  assert(gates.minToolImprovementPct >= 10, "Tool improvement threshold must be at least 10 percent.");
  assert(gates.minLatencyImprovementPct >= 10, "Latency improvement threshold must be at least 10 percent.");
  assert(gates.maxOtherRegressionPct <= 10, "Other-regression threshold must not exceed 10 percent.");
  return profile;
}

function validateProfileAgainstTasks(profile, tasks) {
  const counts = {};
  for (const task of tasks.tasks) counts[task.category] = (counts[task.category] || 0) + 1;
  const required = profile.qualityGates.requiredCategoryPasses;
  assert(Object.keys(required).sort().join("\n") === Object.keys(counts).sort().join("\n"), "Profile category gates must cover every task category exactly.");
  for (const [category, count] of Object.entries(counts)) {
    assert(required[category] === count, `Profile must require every ${category} task to pass (${count}).`);
  }
  const taskCount = tasks.tasks.length;
  assert(profile.qualityGates.minBlindNonInferior >= Math.ceil(taskCount * 0.8), "Blind non-inferiority gate must cover at least 80 percent of tasks.");
  assert(profile.qualityGates.maxBlindLosses <= Math.floor(taskCount * 0.1), "Blind loss gate must not exceed 10 percent of tasks.");
  assert(profile.qualityGates.minBlindNetWins >= Math.max(1, Math.ceil(taskCount / 6)), "Blind net-win gate is too weak for the task count.");
}

export function initExperiment(options = {}) {
  const snapshotPath = path.resolve(options.snapshotPath || "");
  const tasksPath = path.resolve(options.tasksPath || "");
  const profilePath = path.resolve(options.profilePath || "");
  const snapshotArtifact = readPrivateJsonArtifact(snapshotPath);
  const tasksArtifact = readPrivateJsonArtifact(tasksPath);
  const profileArtifact = readPrivateJsonArtifact(profilePath);
  const snapshot = validateSnapshot(snapshotArtifact.value);
  const tasksRoot = fs.realpathSync(path.dirname(tasksPath));
  const tasks = validateTasks(tasksArtifact.value, { tasksRoot });
  const profile = validateProfile(profileArtifact.value);
  validateProfileAgainstTasks(profile, tasks);
  const repetitions = Number(options.repetitions ?? 3);
  assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10, "Repetitions must be an integer from 1 to 10.");
  assertString(options.model, "Experiment model");
  assertString(options.reasoning, "Experiment reasoning");
  const experiment = {
    schema: SCHEMAS.experiment,
    generatedAt: timestamp(),
    tool: `contextlean/${V2_VERSION}`,
    snapshot: { path: snapshotPath, sha256: snapshotArtifact.sha256, snapshotSha256: snapshot.snapshotSha256 },
    tasks: {
      path: tasksPath,
      sha256: tasksArtifact.sha256,
      count: tasks.tasks.length,
      heldOutCount: tasks.tasks.filter((task) => task.heldOut).length,
      items: tasks.tasks.map((task) => ({ ...task, taskSha256: hashObject(task) })),
    },
    profile: { path: profilePath, sha256: profileArtifact.sha256, value: profile },
    environment: {
      model: options.model,
      reasoning: options.reasoning,
      sessionPersistence: false,
      toolPolicy: "per-task-allowlist",
    },
    repetitions,
    maxCandidatesPerTarget: 2,
    randomizationSeed: crypto.randomBytes(16).toString("hex"),
  };
  experiment.experimentSha256 = hashObject(experiment);
  return experiment;
}

function validateExperiment(experiment) {
  assert(isObject(experiment) && experiment.schema === SCHEMAS.experiment, `Expected ${SCHEMAS.experiment}.`);
  assertSha256(experiment.experimentSha256, "experimentSha256");
  const copy = { ...experiment };
  delete copy.experimentSha256;
  assert(hashObject(copy) === experiment.experimentSha256, "Experiment self-hash mismatch.");
  const profile = validateProfile(experiment.profile?.value);
  const tasksRoot = fs.realpathSync(path.dirname(experiment.tasks?.path || ""));
  const tasks = validateTasks({ schema: SCHEMAS.tasks, tasks: experiment.tasks?.items || [] }, { allowTaskSha256: true, tasksRoot });
  for (const task of tasks.tasks) {
    assertSha256(task.taskSha256, `Task ${task.id} taskSha256`);
    const { taskSha256, ...frozenTask } = task;
    assert(hashObject(frozenTask) === taskSha256, `Task ${task.id} self-hash mismatch.`);
  }
  validateProfileAgainstTasks(profile, tasks);
  assert(experiment.tasks.count === tasks.tasks.length, "Experiment task count does not match embedded tasks.");
  assert(experiment.tasks.heldOutCount === tasks.tasks.filter((task) => task.heldOut).length, "Experiment held-out count does not match embedded tasks.");
  assertString(experiment.environment?.model, "Experiment model");
  assertString(experiment.environment?.reasoning, "Experiment reasoning");
  assert(experiment.environment.sessionPersistence === false, "Experiment sessions must be non-persistent.");
  assert(experiment.environment.toolPolicy === "per-task-allowlist", "Experiment tool policy is invalid.");
  assert(Number.isInteger(experiment.repetitions) && experiment.repetitions >= 1 && experiment.repetitions <= 10, "Experiment repetitions are invalid.");
  assert(experiment.maxCandidatesPerTarget === 2, "Experiment maxCandidatesPerTarget must be 2.");
  assert(typeof experiment.randomizationSeed === "string" && /^[a-f0-9]{32}$/.test(experiment.randomizationSeed), "Experiment randomization seed is invalid.");
  return experiment;
}

function sensitiveTextFinding(content) {
  const patterns = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private-key-block"],
    [/\b(?:sk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{12,}\b/, "credential-like-token"],
    [/\bAKIA[0-9A-Z]{16}\b/, "aws-access-key"],
    [/(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i, "credential-assignment"],
  ];
  return patterns.find(([pattern]) => pattern.test(content))?.[1] || null;
}

function assertNoSensitiveText(content, label) {
  const finding = sensitiveTextFinding(content);
  assert(!finding, `${label} contains ${finding}; refusing to send or persist it.`);
}

function forbiddenAdapterKey(value) {
  if (Array.isArray(value)) return value.some(forbiddenAdapterKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => /^(?:env|environment|secret|password|token|apiKey)$/i.test(key) || forbiddenAdapterKey(nested));
}

function validateAdapterSpec(spec, expectedRole) {
  assert(isObject(spec) && spec.schema === SCHEMAS.adapter, `Expected ${SCHEMAS.adapter}.`);
  const allowedKeys = new Set(["schema", "role", "argv", "timeoutMs", "sandboxReceipt"]);
  for (const key of Object.keys(spec)) assert(allowedKeys.has(key), `Adapter spec contains unsupported field: ${key}`);
  assert(spec.role === expectedRole, `Adapter role must be ${expectedRole}.`);
  assert(Array.isArray(spec.argv) && spec.argv.length > 0 && spec.argv.every((item) => typeof item === "string" && item.length > 0), "Adapter argv must be a non-empty string array.");
  assert(path.isAbsolute(spec.argv[0]), "Adapter executable must be an absolute path.");
  let executable;
  try {
    executable = fs.realpathSync(spec.argv[0]);
  } catch {
    fail("Adapter executable must resolve to a regular file.");
  }
  assert(fs.statSync(executable).isFile(), "Adapter executable must resolve to a regular file.");
  assert(Number.isInteger(spec.timeoutMs) && spec.timeoutMs >= 100 && spec.timeoutMs <= 900_000, "Adapter timeoutMs must be between 100 and 900000.");
  assert(!forbiddenAdapterKey(spec), "Adapter specs must not contain environment variables or credentials.");
  for (const argument of spec.argv) {
    assert(!/(?:^|--)\b(?:api[-_]?key|access[-_]?token|password|secret)(?:=|$)/i.test(argument), "Adapter argv must not contain credential flags.");
    assertNoSensitiveText(argument, "Adapter argv");
  }
  adapterFileArguments(spec.argv);
  if (expectedRole === "runner") {
    assert(isObject(spec.sandboxReceipt), "Runner adapter specs must bind a sandboxReceipt.");
    assert(Object.keys(spec.sandboxReceipt).sort().join("\n") === "path\nsha256", "sandboxReceipt may contain only path and sha256.");
    assertString(spec.sandboxReceipt.path, "sandboxReceipt.path");
    assert(path.isAbsolute(spec.sandboxReceipt.path), "sandboxReceipt.path must be absolute.");
    assertSha256(spec.sandboxReceipt.sha256, "sandboxReceipt.sha256");
  } else {
    assert(spec.sandboxReceipt === undefined, `Only runner adapters may declare sandboxReceipt.`);
  }
  return spec;
}

function validateSandboxReceipt(binding) {
  const receiptPath = path.resolve(binding.path);
  assert(existingRegularFile(receiptPath), "Sandbox qualification receipt must be a regular file.");
  const artifact = readPrivateJsonArtifact(receiptPath);
  const actualSha256 = artifact.sha256;
  assert(actualSha256 === binding.sha256, "Sandbox qualification receipt hash mismatch.");
  const receipt = artifact.value;
  assert(receipt.schema === "contextlean.sandbox-receipt/v1", "Unsupported sandbox qualification receipt schema.");
  assert(receipt.qualified === true, "Sandbox qualification receipt is not passing.");
  assertString(receipt.backend, "Sandbox qualification backend");
  assert(Buffer.byteLength(receipt.backend) <= 128, "Sandbox qualification backend exceeds 128 bytes.");
  assertNoSensitiveText(receipt.backend, "Sandbox qualification backend");
  assertSha256(receipt.policySha256, "Sandbox qualification policySha256");
  return { sha256: actualSha256, backend: receipt.backend, policySha256: receipt.policySha256 };
}

function adapterEnvironment(source = process.env) {
  const exact = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "LANG",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE)/i.test(key)) continue;
    const upper = key.toUpperCase();
    if (exact.has(upper) || /^LC_/.test(upper) || /^XDG_/.test(upper)) result[key] = value;
  }
  return result;
}

function prepareAdapter(specPath, expectedRole) {
  const resolvedSpec = path.resolve(specPath);
  const specArtifact = readPrivateJsonArtifact(resolvedSpec);
  const spec = validateAdapterSpec(specArtifact.value, expectedRole);
  const sandboxReceipt = expectedRole === "runner" ? validateSandboxReceipt(spec.sandboxReceipt) : null;
  const fingerprint = executableFingerprint(spec.argv);
  const binding = {
    role: expectedRole,
    adapterSpecSha256: specArtifact.sha256,
    executableFingerprint: fingerprint,
    sandboxReceiptSha256: sandboxReceipt?.sha256 || null,
    sandboxBackend: sandboxReceipt?.backend || null,
    sandboxPolicySha256: sandboxReceipt?.policySha256 || null,
    environmentPolicy: "minimal-no-credentials-no-proxy-inheritance",
  };
  binding.bindingSha256 = hashObject(binding);
  return { spec, sandboxReceipt, binding };
}

export function inspectAdapterBinding(specPath, expectedRole) {
  return prepareAdapter(specPath, expectedRole).binding;
}

export function invokeAdapter(specPath, expectedRole, request) {
  const { spec, sandboxReceipt, binding } = prepareAdapter(specPath, expectedRole);
  const adapterRequest = sandboxReceipt ? { ...request, sandboxReceipt } : request;
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
    input: `${JSON.stringify(adapterRequest)}\n`,
    encoding: "utf8",
    timeout: spec.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    env: adapterEnvironment(),
  });
  if (result.error) fail(`Adapter ${expectedRole} failed to execute (${result.error.code || result.error.name}).`);
  if (result.status !== 0) fail(`Adapter ${expectedRole} exited with status ${result.status}; stderr was intentionally not persisted.`);
  assert(typeof result.stdout === "string" && result.stdout.length > 0 && Buffer.byteLength(result.stdout) <= MAX_JSON_ARTIFACT_BYTES, `Adapter ${expectedRole} output is empty or too large.`);
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail(`Adapter ${expectedRole} must emit exactly one JSON value on stdout.`);
  }
  if (sandboxReceipt) {
    assert(response?.sandbox?.receiptSha256 === sandboxReceipt.sha256, "Runner output does not match the bound sandbox qualification receipt.");
  }
  return { response, binding };
}

function targetFromExperiment(experiment, targetPath) {
  const snapshotArtifact = readPrivateJsonArtifact(experiment.snapshot.path);
  const snapshot = validateSnapshot(snapshotArtifact.value);
  assert(snapshotArtifact.sha256 === experiment.snapshot.sha256, "Snapshot artifact changed after experiment initialization.");
  const root = path.resolve(snapshot.root);
  const target = path.isAbsolute(targetPath) ? path.resolve(targetPath) : resolveInside(root, targetPath);
  assert(target === root || pathInside(root, target), "Optimization target must stay inside the snapshot root.");
  assert(ALLOWED_TARGET_NAMES.has(path.basename(target)), `Unsupported optimization target: ${path.basename(target)}`);
  assert(existingRegularFile(target), "Optimization target must be a regular non-sensitive file.");
  const currentSha256 = fileSha256(target);
  const matchingSurface = snapshot.surfaces.find((surface) => surface.path === target && surface.sha256 === currentSha256 && surface.mutability === "reviewed_replace");
  assert(matchingSurface, "Target and current hash were not present as a reviewed surface in the snapshot.");
  return { root, target, relativePath: path.relative(root, target), currentSha256, surface: matchingSurface };
}

export function generateCandidates(options = {}) {
  const experimentPath = path.resolve(options.experimentPath || "");
  const experimentArtifact = readPrivateJsonArtifact(experimentPath);
  const experiment = validateExperiment(experimentArtifact.value);
  assert(readPrivateJsonArtifact(experiment.profile.path).sha256 === experiment.profile.sha256, "Profile changed after experiment initialization.");
  const selected = targetFromExperiment(experiment, options.targetPath);
  const baselineContent = readText(selected.target, 1_000_000);
  assertPlainText(baselineContent, "Optimization target");
  assertNoSensitiveText(baselineContent, "Optimization target");
  const developmentTasks = experiment.tasks.items
    .filter((task) => !task.heldOut)
    .map(({ taskSha256, ...task }) => task);
  const request = {
    schema: "contextlean.optimizer-request/v1",
    role: "optimizer",
    target: {
      kind: selected.surface.kind,
      basename: path.basename(selected.target),
      content: baselineContent,
      sha256: selected.currentSha256,
      bytes: Buffer.byteLength(baselineContent),
    },
    invariants: experiment.profile.value.invariants,
    objectives: experiment.profile.value.objectives || [],
    developmentTasks,
    maxCandidates: experiment.maxCandidatesPerTarget,
  };
  const { response, binding } = invokeAdapter(options.adapterPath, "optimizer", request);
  assert(isObject(response) && response.schema === "contextlean.optimizer-output/v1", "Optimizer returned an invalid schema.");
  assert(Array.isArray(response.variants) && response.variants.length >= 1 && response.variants.length <= experiment.maxCandidatesPerTarget, "Optimizer must return one or two variants.");
  const requiredIds = new Set(experiment.profile.value.invariants.map((item) => item.id));
  const ids = new Set();
  const contents = new Set([baselineContent]);
  const variants = response.variants.map((variant) => {
    assertString(variant.id, "Candidate id");
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(variant.id), `Invalid candidate id: ${variant.id}`);
    assert(!ids.has(variant.id), `Duplicate candidate id: ${variant.id}`);
    ids.add(variant.id);
    assertString(variant.rationale, `Candidate ${variant.id} rationale`);
    assertPlainText(variant.rationale, `Candidate ${variant.id} rationale`);
    assert(Buffer.byteLength(variant.rationale) <= 8_000, `Candidate ${variant.id} rationale exceeds 8 KB.`);
    assertNoSensitiveText(variant.rationale, `Candidate ${variant.id} rationale`);
    assert(typeof variant.content === "string" && variant.content.length > 0, `Candidate ${variant.id} content must be non-empty.`);
    assertPlainText(variant.content, `Candidate ${variant.id}`);
    assert(Buffer.byteLength(variant.content) <= MAX_SELECTED_TEXT_BYTES, `Candidate ${variant.id} exceeds 1 MB.`);
    assert(!contents.has(variant.content), `Candidate ${variant.id} duplicates another variant or the baseline.`);
    contents.add(variant.content);
    assertNoSensitiveText(variant.content, `Candidate ${variant.id}`);
    assert(Array.isArray(variant.preservedInvariantIds), `Candidate ${variant.id} must declare preservedInvariantIds.`);
    const preserved = new Set(variant.preservedInvariantIds);
    for (const id of requiredIds) assert(preserved.has(id), `Candidate ${variant.id} did not preserve invariant ${id}.`);
    return {
      id: variant.id,
      rationale: variant.rationale,
      content: variant.content,
      contentSha256: hashValue(variant.content),
      bytes: Buffer.byteLength(variant.content),
      approximateTokens: Math.ceil(Buffer.byteLength(variant.content) / 4),
      preservedInvariantIds: [...preserved].sort(),
    };
  });
  const candidate = {
    schema: SCHEMAS.candidate,
    generatedAt: timestamp(),
    tool: `contextlean/${V2_VERSION}`,
    experiment: { path: experimentPath, sha256: experimentArtifact.sha256, experimentSha256: experiment.experimentSha256 },
    snapshotSha256: experiment.snapshot.snapshotSha256,
    target: {
      root: selected.root,
      path: selected.relativePath,
      kind: selected.surface.kind,
      expectedSha256: selected.currentSha256,
      baselineContent,
      baselineContentSha256: hashValue(baselineContent),
    },
    variants,
    generator: {
      adapterSpecSha256: binding.adapterSpecSha256,
      executableFingerprint: binding.executableFingerprint,
      bindingSha256: binding.bindingSha256,
      environmentPolicy: binding.environmentPolicy,
      heldOutTasksDisclosed: false,
    },
    privacy: {
      artifactProtection: process.platform === "win32" ? "platform-inherited-acl" : "posix-0600",
      sensitivePatternsDetected: false,
      authOrTranscriptContentIncluded: false,
    },
  };
  candidate.candidateSha256 = hashObject(candidate);
  return candidate;
}

function validateCandidate(candidate, experiment = null) {
  assert(isObject(candidate) && candidate.schema === SCHEMAS.candidate, `Expected ${SCHEMAS.candidate}.`);
  assertOnlyKeys(candidate, ["schema", "generatedAt", "tool", "experiment", "snapshotSha256", "target", "variants", "generator", "privacy", "candidateSha256"], "Candidate artifact");
  assertSha256(candidate.candidateSha256, "candidateSha256");
  const copy = { ...candidate };
  delete copy.candidateSha256;
  assert(hashObject(copy) === candidate.candidateSha256, "Candidate self-hash mismatch.");
  assert(isObject(candidate.experiment), "Candidate experiment binding is invalid.");
  assertOnlyKeys(candidate.experiment, ["path", "sha256", "experimentSha256"], "Candidate experiment binding");
  assertString(candidate.experiment.path, "Candidate experiment path");
  assertSha256(candidate.experiment.sha256, "Candidate experiment artifact sha256");
  assertSha256(candidate.experiment.experimentSha256, "Candidate experimentSha256");
  assertSha256(candidate.snapshotSha256, "Candidate snapshotSha256");
  assert(isObject(candidate.target), "Candidate target is invalid.");
  assertOnlyKeys(candidate.target, ["root", "path", "kind", "expectedSha256", "baselineContent", "baselineContentSha256"], "Candidate target");
  assertString(candidate.target.root, "Candidate target root");
  assertString(candidate.target.path, "Candidate target path");
  assert(!path.isAbsolute(candidate.target.path), "Candidate target path must be relative.");
  assertSha256(candidate.target.expectedSha256, "Candidate target expectedSha256");
  assertPlainText(candidate.target.baselineContent, "Candidate baseline content");
  assert(Buffer.byteLength(candidate.target.baselineContent) <= MAX_SELECTED_TEXT_BYTES, "Candidate baseline content exceeds 1 MB.");
  assertNoSensitiveText(candidate.target.baselineContent, "Candidate baseline content");
  assert(hashValue(candidate.target.baselineContent) === candidate.target.baselineContentSha256, "Candidate baseline content hash mismatch.");
  assert(Array.isArray(candidate.variants) && candidate.variants.length >= 1 && candidate.variants.length <= 2, "Candidate must contain one or two variants.");
  const ids = new Set();
  const contents = new Set([candidate.target.baselineContent]);
  const requiredInvariants = new Set(experiment?.profile?.value?.invariants?.map((item) => item.id) || []);
  for (const variant of candidate.variants) {
    assertOnlyKeys(variant, ["id", "rationale", "content", "contentSha256", "bytes", "approximateTokens", "preservedInvariantIds"], "Candidate variant");
    assertString(variant.id, "Candidate id");
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(variant.id), `Invalid candidate id: ${variant.id}`);
    assert(!ids.has(variant.id), `Duplicate candidate id: ${variant.id}`);
    ids.add(variant.id);
    assertString(variant.rationale, `Candidate ${variant.id} rationale`);
    assertPlainText(variant.rationale, `Candidate ${variant.id} rationale`);
    assert(Buffer.byteLength(variant.rationale) <= 8_000, `Candidate ${variant.id} rationale exceeds 8 KB.`);
    assertNoSensitiveText(variant.rationale, `Candidate ${variant.id} rationale`);
    assertPlainText(variant.content, `Candidate ${variant.id} content`);
    assert(variant.content.length > 0 && Buffer.byteLength(variant.content) <= MAX_SELECTED_TEXT_BYTES, `Candidate ${variant.id} content must be between 1 byte and 1 MB.`);
    assertNoSensitiveText(variant.content, `Candidate ${variant.id} content`);
    assert(!contents.has(variant.content), `Candidate ${variant.id} duplicates another variant or the baseline.`);
    contents.add(variant.content);
    assert(hashValue(variant.content) === variant.contentSha256, `Candidate content hash mismatch: ${variant.id}`);
    const contentBytes = Buffer.byteLength(variant.content);
    assert(variant.bytes === contentBytes, `Candidate ${variant.id} byte count mismatch.`);
    assert(variant.approximateTokens === Math.ceil(contentBytes / 4), `Candidate ${variant.id} token estimate mismatch.`);
    assert(Array.isArray(variant.preservedInvariantIds), `Candidate ${variant.id} preservedInvariantIds are invalid.`);
    const preserved = new Set(variant.preservedInvariantIds);
    assert(preserved.size === variant.preservedInvariantIds.length, `Candidate ${variant.id} has duplicate preservedInvariantIds.`);
    for (const invariantId of preserved) assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(invariantId), `Candidate ${variant.id} has an invalid invariant id.`);
    for (const invariantId of requiredInvariants) assert(preserved.has(invariantId), `Candidate ${variant.id} did not preserve invariant ${invariantId}.`);
  }
  assert(isObject(candidate.generator), "Candidate generator binding is invalid.");
  assertOnlyKeys(candidate.generator, ["adapterSpecSha256", "executableFingerprint", "bindingSha256", "environmentPolicy", "heldOutTasksDisclosed"], "Candidate generator binding");
  assertSha256(candidate.generator.adapterSpecSha256, "Candidate generator adapterSpecSha256");
  assertSha256(candidate.generator.bindingSha256, "Candidate generator bindingSha256");
  assert(Array.isArray(candidate.generator.executableFingerprint) && candidate.generator.executableFingerprint.length > 0, "Candidate generator executable fingerprint is missing.");
  for (const item of candidate.generator.executableFingerprint) {
    assert(Number.isInteger(item.argvIndex) && item.argvIndex >= 0, "Candidate generator executable fingerprint index is invalid.");
    assertSha256(item.sha256, "Candidate generator executable fingerprint sha256");
  }
  assert(candidate.generator.environmentPolicy === "minimal-no-credentials-no-proxy-inheritance", "Candidate generator environment policy is invalid.");
  assert(candidate.generator?.heldOutTasksDisclosed === false, "Candidate generator must not receive held-out tasks.");
  assertOnlyKeys(candidate.privacy, ["artifactProtection", "sensitivePatternsDetected", "authOrTranscriptContentIncluded"], "Candidate privacy record");
  assert(["posix-0600", "platform-inherited-acl"].includes(candidate.privacy?.artifactProtection), "Candidate artifact protection is invalid.");
  assert(candidate.privacy.sensitivePatternsDetected === false, "Candidate cannot declare detected sensitive patterns.");
  assert(candidate.privacy.authOrTranscriptContentIncluded === false, "Candidate cannot include auth or transcript content.");
  return candidate;
}

function validateMetrics(metrics) {
  assert(isObject(metrics), "Runner metrics must be an object.");
  assertOnlyKeys(metrics, [...METRIC_KEYS, "unavailableReasons"], "Runner metrics");
  assert(isObject(metrics.unavailableReasons), "Runner metrics must include unavailableReasons.");
  for (const [key, reason] of Object.entries(metrics.unavailableReasons)) {
    assert(METRIC_KEYS.includes(key), `Unavailable reason refers to an unknown metric: ${key}`);
    assertString(reason, `Unavailable reason for ${key}`);
    assert(Buffer.byteLength(reason) <= 512, `Unavailable reason for ${key} exceeds 512 bytes.`);
    assertNoSensitiveText(reason, `Unavailable reason for ${key}`);
  }
  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    assert(value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0), `Metric ${key} must be a non-negative number or null.`);
    if (value === null) assertString(metrics.unavailableReasons[key], `Unavailable reason for ${key}`);
    else assert(metrics.unavailableReasons[key] === undefined, `Metric ${key} is available but also has an unavailable reason.`);
  }
  return metrics;
}

function validateObservedEnvironment(environment, expected) {
  assert(isObject(environment), "Runner must report its observed environment.");
  assert(Object.keys(environment).sort().join("\n") === "model\nreasoning\nsessionPersistence\ntoolPolicy", "Runner observed environment contains unsupported fields.");
  assert(environment.model === expected.model, "Runner observed a different model than the frozen experiment.");
  assert(environment.reasoning === expected.reasoning, "Runner observed a different reasoning level than the frozen experiment.");
  assert(environment.sessionPersistence === false, "Runner must use a fresh non-persistent session.");
  assert(environment.toolPolicy === expected.toolPolicy, "Runner observed a different tool policy than the frozen experiment.");
  return environment;
}

function validateRunnerOutput(response, expectedEnvironment) {
  assert(isObject(response) && response.schema === "contextlean.runner-output/v1", "Runner returned an invalid schema.");
  assert(typeof response.output === "string" && Buffer.byteLength(response.output) <= 1_000_000, "Runner output must be a string no larger than 1 MB.");
  assertPlainText(response.output, "Runner output");
  assertNoSensitiveText(response.output, "Runner output");
  assert(typeof response.success === "boolean", "Runner success must be boolean.");
  validateMetrics(response.metrics);
  validateObservedEnvironment(response.environment, expectedEnvironment);
  assert(isObject(response.sideEffects), "Runner sideEffects must be an object.");
  for (const key of SIDE_EFFECT_KEYS) assert(Number.isInteger(response.sideEffects[key]) && response.sideEffects[key] >= 0, `Side effect ${key} must be a non-negative integer.`);
  assert(response.sandbox?.qualified === true, "Runner must provide a qualified sandbox receipt.");
  assertSha256(response.sandbox.receiptSha256, "sandbox.receiptSha256");
  assert(Object.keys(response.sandbox).sort().join("\n") === "qualified\nreceiptSha256", "Runner sandbox output contains unsupported fields.");
  return response;
}

function evaluateJsonFileLineCitations(assertion, output, tasksRoot) {
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  let parsed;
  try {
    parsed = JSON.parse(output);
    add("jsonFileLineCitations:json", true);
  } catch {
    add("jsonFileLineCitations:json", false);
    return checks;
  }
  const items = isObject(parsed) ? parsed[assertion.jsonField] : undefined;
  add("jsonFileLineCitations:fieldArray", Array.isArray(items));
  if (!Array.isArray(items)) return checks;
  add("jsonFileLineCitations:minItems", items.length >= assertion.minItems);

  const allowlist = new Map(assertion.sources.map((source) => [source.path, source]));
  const citationsBySource = new Map();
  items.forEach((item, index) => {
    const value = isObject(item) ? item[assertion.citationField] : undefined;
    add(`jsonFileLineCitations:${index}:string`, typeof value === "string");
    if (typeof value !== "string") return;
    const match = value.match(/^([^:\r\n]+):([1-9][0-9]*)$/);
    const lineNumber = match ? Number(match[2]) : NaN;
    const syntaxOk = Boolean(match) && Number.isSafeInteger(lineNumber);
    add(`jsonFileLineCitations:${index}:syntax`, syntaxOk);
    if (!syntaxOk) return;
    const source = allowlist.get(match[1]);
    add(`jsonFileLineCitations:${index}:allowlist`, Boolean(source));
    if (!source) return;
    const citations = citationsBySource.get(source.path) || [];
    citations.push({ index, lineNumber });
    citationsBySource.set(source.path, citations);
  });

  for (const [sourceRelativePath, citations] of citationsBySource.entries()) {
    const source = allowlist.get(sourceRelativePath);
    const sourcePath = resolveInside(tasksRoot, sourceRelativePath);
    const safeSource = resolveSafeRegularRead(sourcePath, MAX_CANONICAL_SOURCE_BYTES);
    const ranges = citations.map(({ index, lineNumber }) => ({
      id: `citation-${index}`,
      startLine: lineNumber,
      endLine: lineNumber,
    }));
    const inspected = inspectSourceRanges(safeSource.resolved, ranges);
    add(`jsonFileLineCitations:${sourceRelativePath}:sha256`, inspected.sha256 === source.sha256);
    for (const { index } of citations) {
      const rangeId = `citation-${index}`;
      const exists = !inspected.invalidRanges.includes(rangeId);
      add(`jsonFileLineCitations:${index}:exists`, exists);
      add(`jsonFileLineCitations:${index}:nonEmpty`, exists && hasVisibleText(inspected.chunks.get(rangeId)));
    }
  }
  return checks;
}

export function evaluateAssertions(task, response, options = {}) {
  const assertions = task.assertions;
  const checks = [];
  function add(name, ok) {
    checks.push({ name, ok: Boolean(ok) });
  }
  if (assertions.success !== undefined) add("success", response.success === assertions.success);
  if (assertions.outputEquals !== undefined) add("outputEquals", response.output === assertions.outputEquals);
  if (Array.isArray(assertions.outputIncludes)) {
    assertions.outputIncludes.forEach((value, index) => add(`outputIncludes:${index}`, response.output.includes(value)));
  }
  if (Array.isArray(assertions.outputExcludes)) {
    assertions.outputExcludes.forEach((value, index) => add(`outputExcludes:${index}`, !response.output.includes(value)));
  }
  if (assertions.exactToolCalls !== undefined) add("exactToolCalls", response.metrics.toolCalls === assertions.exactToolCalls);
  if (assertions.maxToolCalls !== undefined) add("maxToolCalls", response.metrics.toolCalls !== null && response.metrics.toolCalls <= assertions.maxToolCalls);
  if (assertions.maxRepeatedReads !== undefined) add("maxRepeatedReads", response.metrics.repeatedReads !== null && response.metrics.repeatedReads <= assertions.maxRepeatedReads);
  if (assertions.jsonFileLineCitations !== undefined) {
    assertString(options.tasksRoot, `Task ${task.id} citation task root`);
    checks.push(...evaluateJsonFileLineCitations(assertions.jsonFileLineCitations, response.output, options.tasksRoot));
  }
  if (assertions.sideEffectsZero !== false) {
    for (const key of SIDE_EFFECT_KEYS) add(`${key}:zero`, response.sideEffects[key] === 0);
  }
  return { pass: checks.every((check) => check.ok), checks };
}

function runOneVariant(runnerPath, experiment, task, variantLabel, content, repetition, executionIndex) {
  const request = {
    schema: "contextlean.runner-request/v1",
    role: "runner",
    task: {
      id: task.id,
      category: task.category,
      prompt: task.prompt,
      allowedTools: task.allowedTools,
      rubric: task.rubric || "Satisfy the task exactly without unauthorized side effects.",
    },
    variant: { label: variantLabel, context: content },
    environment: experiment.environment,
    repetition,
    executionIndex,
  };
  const { response, binding } = invokeAdapter(runnerPath, "runner", request);
  validateRunnerOutput(response, experiment.environment);
  const evaluation = evaluateAssertions(task, response, { tasksRoot: fs.realpathSync(path.dirname(experiment.tasks.path)) });
  return {
    taskId: task.id,
    category: task.category,
    heldOut: task.heldOut,
    measureLatency: task.measureLatency === true,
    repetition,
    executionIndex,
    deterministicPass: evaluation.pass,
    checks: evaluation.checks,
    success: response.success,
    outputSha256: hashValue(response.output),
    metrics: response.metrics,
    sideEffects: response.sideEffects,
    sandbox: response.sandbox,
    environment: response.environment,
    adapterBindingSha256: binding.bindingSha256,
    _adapterBinding: binding,
    _output: response.output,
  };
}

function judgePair(judgePath, experiment, task, candidateId, baselineOutput, candidateOutput) {
  const candidateOnLeft = Number.parseInt(hashValue(`${experiment.randomizationSeed}:${task.id}:${candidateId}`).slice(0, 2), 16) % 2 === 0;
  const left = candidateOnLeft ? candidateOutput : baselineOutput;
  const right = candidateOnLeft ? baselineOutput : candidateOutput;
  const request = {
    schema: "contextlean.judge-request/v1",
    role: "judge",
    task: { prompt: task.prompt, rubric: task.rubric || "Prefer the output that satisfies the task more completely and safely." },
    leftOutput: left,
    rightOutput: right,
    forbiddenEvidence: ["variant identity", "token counts", "latency", "cost"],
  };
  const { response, binding } = invokeAdapter(judgePath, "judge", request);
  assert(isObject(response) && response.schema === "contextlean.judge-output/v1", "Judge returned an invalid schema.");
  assert(["left", "right", "tie"].includes(response.verdict), "Judge verdict must be left, right, or tie.");
  assertString(response.rationale, "Judge rationale");
  assert(Buffer.byteLength(response.rationale) <= 8_000, "Judge rationale exceeds 8 KB.");
  assertNoSensitiveText(response.rationale, "Judge rationale");
  let mapped = "tie";
  if (response.verdict !== "tie") {
    const choseCandidate = (response.verdict === "left") === candidateOnLeft;
    mapped = choseCandidate ? "candidate" : "baseline";
  }
  return {
    taskId: task.id,
    candidateId,
    verdict: mapped,
    rationaleSha256: hashValue(response.rationale),
    rationaleBytes: Buffer.byteLength(response.rationale),
    adapterBindingSha256: binding.bindingSha256,
    _adapterBinding: binding,
  };
}

function stripOutputs(run) {
  const { _output, _adapterBinding, ...safe } = run;
  return safe;
}

function stripJudgeBinding(judgment) {
  const { _adapterBinding, ...safe } = judgment;
  return safe;
}

function sameBinding(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function bindOnce(current, observed, role) {
  if (!current) return observed;
  assert(sameBinding(current, observed), `${role} adapter binding changed during the frozen experiment.`);
  return current;
}

export function runExperiment(options = {}) {
  const experimentPath = path.resolve(options.experimentPath || "");
  const candidatePath = path.resolve(options.candidatePath || "");
  const experimentArtifact = readPrivateJsonArtifact(experimentPath);
  const candidateArtifact = readPrivateJsonArtifact(candidatePath);
  const experiment = validateExperiment(experimentArtifact.value);
  const candidate = validateCandidate(candidateArtifact.value, experiment);
  assert(experimentArtifact.sha256 === candidate.experiment.sha256, "Experiment artifact changed after candidate generation.");
  assert(candidate.experiment.experimentSha256 === experiment.experimentSha256, "Candidate belongs to a different experiment.");
  assert(candidate.snapshotSha256 === experiment.snapshot.snapshotSha256, "Candidate belongs to a different snapshot.");
  const frozenTarget = targetFromExperiment(experiment, candidate.target.path);
  assert(frozenTarget.root === path.resolve(candidate.target.root), "Candidate target root differs from the frozen snapshot root.");
  assert(frozenTarget.currentSha256 === candidate.target.expectedSha256, "Candidate target differs from its frozen target hash.");
  assert(frozenTarget.surface.kind === candidate.target.kind, "Candidate target kind differs from the frozen snapshot surface.");
  const baselineRuns = [];
  const candidateResults = candidate.variants.map((variant) => ({ id: variant.id, runs: [], judgments: [] }));
  let runnerBinding = null;
  let judgeBinding = null;

  for (const task of experiment.tasks.items) {
    const repetitions = task.measureLatency ? experiment.repetitions : 1;
    const baselineOutputRuns = [];
    const candidateOutputRuns = new Map(candidate.variants.map((variant) => [variant.id, []]));
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const scheduled = [
        { id: "baseline", content: candidate.target.baselineContent },
        ...candidate.variants.map((variant) => ({ id: variant.id, content: variant.content })),
      ].sort((left, right) => hashValue(`${experiment.randomizationSeed}:${task.id}:${repetition}:${left.id}`).localeCompare(hashValue(`${experiment.randomizationSeed}:${task.id}:${repetition}:${right.id}`)));
      for (let index = 0; index < scheduled.length; index += 1) {
        const item = scheduled[index];
        const label = `variant-${hashValue(`${experiment.randomizationSeed}:${task.id}:${item.id}:${repetition}`).slice(0, 10)}`;
        const run = runOneVariant(options.runnerPath, experiment, task, label, item.content, repetition, index + 1);
        runnerBinding = bindOnce(runnerBinding, run._adapterBinding, "Runner");
        if (item.id === "baseline") {
          baselineRuns.push(stripOutputs(run));
          baselineOutputRuns.push(run);
        } else {
          candidateResults.find((result) => result.id === item.id).runs.push(stripOutputs(run));
          candidateOutputRuns.get(item.id).push(run);
        }
      }
    }
    for (const variantResult of candidateResults) {
      const judgment = judgePair(options.judgePath, experiment, task, variantResult.id, baselineOutputRuns[0]._output, candidateOutputRuns.get(variantResult.id)[0]._output);
      judgeBinding = bindOnce(judgeBinding, judgment._adapterBinding, "Judge");
      variantResult.judgments.push(stripJudgeBinding(judgment));
    }
  }

  const result = {
    schema: SCHEMAS.result,
    generatedAt: timestamp(),
    tool: `contextlean/${V2_VERSION}`,
    experiment: { path: experimentPath, sha256: experimentArtifact.sha256, experimentSha256: experiment.experimentSha256 },
    candidate: { path: candidatePath, sha256: candidateArtifact.sha256, candidateSha256: candidate.candidateSha256 },
    taskCount: experiment.tasks.count,
    heldOutTaskCount: experiment.tasks.heldOutCount,
    bindings: { runner: runnerBinding, judge: judgeBinding },
    baselineRuns,
    candidates: candidateResults,
    privacy: {
      rawOutputsPersisted: false,
      outputHashesPersisted: true,
      authOrTranscriptContentIncluded: false,
    },
  };
  result.resultSha256 = hashObject(result);
  return result;
}

function validateResult(result) {
  assert(isObject(result) && result.schema === SCHEMAS.result, `Expected ${SCHEMAS.result}.`);
  assertOnlyKeys(result, ["schema", "generatedAt", "tool", "experiment", "candidate", "taskCount", "heldOutTaskCount", "bindings", "baselineRuns", "candidates", "privacy", "resultSha256"], "Result artifact");
  assertSha256(result.resultSha256, "resultSha256");
  const copy = { ...result };
  delete copy.resultSha256;
  assert(hashObject(copy) === result.resultSha256, "Result self-hash mismatch.");
  assert(Array.isArray(result.baselineRuns) && Array.isArray(result.candidates), "Result runs are invalid.");
  assertOnlyKeys(result.experiment, ["path", "sha256", "experimentSha256"], "Result experiment binding");
  assertOnlyKeys(result.candidate, ["path", "sha256", "candidateSha256"], "Result candidate binding");
  assertOnlyKeys(result.bindings, ["runner", "judge"], "Result adapter bindings");
  assertOnlyKeys(result.privacy, ["rawOutputsPersisted", "outputHashesPersisted", "authOrTranscriptContentIncluded"], "Result privacy record");
  assert(result.privacy?.rawOutputsPersisted === false, "Result must not persist raw outputs.");
  assert(result.privacy?.outputHashesPersisted === true, "Result must persist output hashes.");
  assert(result.privacy?.authOrTranscriptContentIncluded === false, "Result must not include auth or transcript content.");
  for (const role of ["runner", "judge"]) validateAdapterBinding(result.bindings?.[role], role);
  const resultSets = [{ label: "Baseline", runs: result.baselineRuns }];
  const candidateIds = new Set();
  for (const candidateResult of result.candidates) {
    assertOnlyKeys(candidateResult, ["id", "runs", "judgments"], "Result candidate evidence");
    assertString(candidateResult.id, "Result candidate id");
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidateResult.id), `Result candidate id is invalid: ${candidateResult.id}`);
    assert(!candidateIds.has(candidateResult.id), `Duplicate result candidate id: ${candidateResult.id}`);
    candidateIds.add(candidateResult.id);
    assert(Array.isArray(candidateResult.runs) && Array.isArray(candidateResult.judgments), `Result candidate ${candidateResult.id} evidence is invalid.`);
    resultSets.push({ label: `Candidate ${candidateResult.id}`, runs: candidateResult.runs });
    for (const judgment of candidateResult.judgments) {
      assertOnlyKeys(judgment, ["taskId", "candidateId", "verdict", "rationaleSha256", "rationaleBytes", "adapterBindingSha256"], "Judgment");
      assert(judgment.rationale === undefined, "Raw judge rationale must not be persisted.");
      assertString(judgment.taskId, "Judgment taskId");
      assertString(judgment.candidateId, "Judgment candidateId");
      assert(["candidate", "baseline", "tie"].includes(judgment.verdict), `Judgment verdict is invalid for ${judgment.taskId}.`);
      assertSha256(judgment.rationaleSha256, `Judgment rationaleSha256 for ${judgment.taskId}`);
      assert(Number.isInteger(judgment.rationaleBytes) && judgment.rationaleBytes > 0 && judgment.rationaleBytes <= 8_000, `Judgment rationaleBytes is invalid for ${judgment.taskId}.`);
      assertSha256(judgment.adapterBindingSha256, `Judgment adapterBindingSha256 for ${judgment.taskId}`);
    }
  }
  for (const { label, runs } of resultSets) {
    for (const run of runs) {
      assertOnlyKeys(run, ["taskId", "category", "heldOut", "measureLatency", "repetition", "executionIndex", "deterministicPass", "checks", "success", "outputSha256", "metrics", "sideEffects", "sandbox", "environment", "adapterBindingSha256"], `${label} run`);
      assert(run.output === undefined && run._output === undefined, "Raw runner output must not be persisted.");
      assertString(run.taskId, `${label} taskId`);
      assertSha256(run.outputSha256, `${label} outputSha256`);
      assert(typeof run.deterministicPass === "boolean", `${label} deterministicPass is invalid.`);
      assert(Array.isArray(run.checks), `${label} checks are invalid.`);
      for (const check of run.checks) {
        assertOnlyKeys(check, ["name", "ok"], `${label} check`);
        assertString(check.name, `${label} check name`);
        assert(Buffer.byteLength(check.name) <= 256, `${label} check name exceeds 256 bytes.`);
        assertNoSensitiveText(check.name, `${label} check name`);
        assert(typeof check.ok === "boolean", `${label} check status is invalid.`);
      }
      validateMetrics(run.metrics);
      assert(isObject(run.sideEffects), `${label} sideEffects are invalid.`);
      assertOnlyKeys(run.sideEffects, SIDE_EFFECT_KEYS, `${label} sideEffects`);
      for (const key of SIDE_EFFECT_KEYS) assert(Number.isInteger(run.sideEffects[key]) && run.sideEffects[key] >= 0, `${label} side effect ${key} is invalid.`);
      assert(run.sandbox?.qualified === true, `${label} sandbox is not qualified.`);
      assertOnlyKeys(run.sandbox, ["qualified", "receiptSha256"], `${label} sandbox`);
      assertSha256(run.sandbox?.receiptSha256, `${label} sandbox receiptSha256`);
      validateObservedEnvironment(run.environment, run.environment);
      assertSha256(run.adapterBindingSha256, `${label} adapterBindingSha256`);
    }
  }
  return result;
}

function validateAdapterBinding(binding, role) {
  assert(isObject(binding) && binding.role === role, `Result is missing its frozen ${role} binding.`);
  assertOnlyKeys(binding, ["role", "adapterSpecSha256", "executableFingerprint", "sandboxReceiptSha256", "sandboxBackend", "sandboxPolicySha256", "environmentPolicy", "bindingSha256"], `${role} adapter binding`);
  assertSha256(binding.bindingSha256, `${role} bindingSha256`);
  const copy = { ...binding };
  delete copy.bindingSha256;
  assert(hashObject(copy) === binding.bindingSha256, `${role} binding self-hash mismatch.`);
  assertSha256(binding.adapterSpecSha256, `${role} adapterSpecSha256`);
  assert(Array.isArray(binding.executableFingerprint) && binding.executableFingerprint.length > 0, `${role} executable fingerprint is missing.`);
  for (const item of binding.executableFingerprint) {
    assertOnlyKeys(item, ["argvIndex", "sha256"], `${role} executable fingerprint`);
    assert(Number.isInteger(item.argvIndex) && item.argvIndex >= 0, `${role} executable fingerprint index is invalid.`);
    assertSha256(item.sha256, `${role} executable fingerprint sha256`);
  }
  if (role === "runner") {
    assertSha256(binding.sandboxReceiptSha256, "runner sandboxReceiptSha256");
    assertString(binding.sandboxBackend, "runner sandboxBackend");
    assertSha256(binding.sandboxPolicySha256, "runner sandboxPolicySha256");
  }
  return binding;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function improvementPct(baseline, candidate) {
  if (baseline === null || candidate === null || baseline === 0) return null;
  return ((baseline - candidate) / baseline) * 100;
}

function expectedRunKeys(experiment) {
  const expected = new Map();
  for (const task of experiment.tasks.items) {
    const repetitions = task.measureLatency ? experiment.repetitions : 1;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      expected.set(`${task.id}\u0000${repetition}`, { task, repetition });
    }
  }
  return expected;
}

function indexAndValidateRuns(experiment, runs, expected, bindingSha256, label) {
  assert(runs.length === expected.size, `${label} run count does not match the frozen experiment.`);
  const indexed = new Map();
  for (const run of runs) {
    assertString(run.taskId, `${label} taskId`);
    assert(Number.isInteger(run.repetition) && run.repetition >= 1, `${label} repetition is invalid.`);
    const key = `${run.taskId}\u0000${run.repetition}`;
    const frozen = expected.get(key);
    assert(frozen, `${label} contains an unexpected task/repetition pair: ${run.taskId}/${run.repetition}.`);
    assert(!indexed.has(key), `${label} contains a duplicate task/repetition pair: ${run.taskId}/${run.repetition}.`);
    assert(run.category === frozen.task.category, `${label} category drifted for ${run.taskId}.`);
    assert(run.heldOut === frozen.task.heldOut, `${label} held-out marker drifted for ${run.taskId}.`);
    assert(run.measureLatency === (frozen.task.measureLatency === true), `${label} latency marker drifted for ${run.taskId}.`);
    assert(typeof run.deterministicPass === "boolean", `${label} deterministicPass is invalid.`);
    assertSha256(run.outputSha256, `${label} outputSha256`);
    validateMetrics(run.metrics);
    assert(isObject(run.sideEffects), `${label} sideEffects are invalid.`);
    for (const sideEffect of SIDE_EFFECT_KEYS) assert(Number.isInteger(run.sideEffects[sideEffect]) && run.sideEffects[sideEffect] >= 0, `${label} side effect ${sideEffect} is invalid.`);
    validateObservedEnvironment(run.environment, experiment.environment);
    assert(run.adapterBindingSha256 === bindingSha256, `${label} adapter binding changed or was tampered.`);
    indexed.set(key, run);
  }
  for (const key of expected.keys()) assert(indexed.has(key), `${label} is missing a frozen task/repetition pair.`);
  return indexed;
}

function validateFrozenEvidence(experiment, candidate, result) {
  assert(result.taskCount === experiment.tasks.count, "Result task count does not match the frozen experiment.");
  assert(result.heldOutTaskCount === experiment.tasks.heldOutCount, "Result held-out count does not match the frozen experiment.");
  const expected = expectedRunKeys(experiment);
  const baseline = indexAndValidateRuns(experiment, result.baselineRuns, expected, result.bindings.runner.bindingSha256, "Baseline");
  const expectedCandidateIds = new Set(candidate.variants.map((variant) => variant.id));
  assert(result.candidates.length === expectedCandidateIds.size, "Result candidate count does not match the candidate artifact.");
  const candidates = new Map();
  for (const candidateResult of result.candidates) {
    assert(expectedCandidateIds.has(candidateResult.id), `Result contains an unknown candidate: ${candidateResult.id}`);
    assert(!candidates.has(candidateResult.id), `Result contains duplicate candidate evidence: ${candidateResult.id}`);
    const runs = indexAndValidateRuns(experiment, candidateResult.runs, expected, result.bindings.runner.bindingSha256, `Candidate ${candidateResult.id}`);
    assert(Array.isArray(candidateResult.judgments) && candidateResult.judgments.length === experiment.tasks.count, `Candidate ${candidateResult.id} judgment count is incomplete.`);
    const judgmentTasks = new Set();
    for (const judgment of candidateResult.judgments) {
      assert(judgment.candidateId === candidateResult.id, `Judgment candidate binding changed for ${candidateResult.id}.`);
      assert(experiment.tasks.items.some((task) => task.id === judgment.taskId), `Judgment contains an unknown task: ${judgment.taskId}`);
      assert(!judgmentTasks.has(judgment.taskId), `Candidate ${candidateResult.id} has duplicate judgments for ${judgment.taskId}.`);
      judgmentTasks.add(judgment.taskId);
      assert(["candidate", "baseline", "tie"].includes(judgment.verdict), `Judgment verdict is invalid for ${judgment.taskId}.`);
      assertSha256(judgment.rationaleSha256, `Judgment rationaleSha256 for ${judgment.taskId}`);
      assert(Number.isInteger(judgment.rationaleBytes) && judgment.rationaleBytes > 0 && judgment.rationaleBytes <= 8_000, `Judgment rationaleBytes is invalid for ${judgment.taskId}.`);
      assert(judgment.rationale === undefined, "Raw judge rationale must not be persisted.");
      assert(judgment.adapterBindingSha256 === result.bindings.judge.bindingSha256, `Judge binding changed or was tampered for ${judgment.taskId}.`);
    }
    candidates.set(candidateResult.id, runs);
  }
  return { baseline, candidates };
}

function pairedMetricSummary(baselineRuns, candidateRuns) {
  const summed = new Set(["toolCalls", "repeatedReads", "toolErrors", "retries"]);
  const baseline = {};
  const candidate = {};
  const improvements = {};
  const availability = {};
  for (const metric of METRIC_KEYS) {
    const pairs = [];
    for (const [key, baselineRun] of baselineRuns.entries()) {
      if (metric === "latencyMs" && !baselineRun.measureLatency) continue;
      pairs.push({ key, baseline: baselineRun.metrics[metric], candidate: candidateRuns.get(key).metrics[metric] });
    }
    const missing = pairs.filter((pair) => pair.baseline === null || pair.candidate === null);
    if (!pairs.length || missing.length) {
      baseline[metric] = null;
      candidate[metric] = null;
      improvements[metric] = null;
      availability[metric] = {
        complete: false,
        pairedSamples: pairs.length,
        unavailableReason: !pairs.length ? "no-eligible-paired-samples" : `missing-paired-values:${missing.length}`,
      };
      continue;
    }
    const baselineValues = pairs.map((pair) => pair.baseline);
    const candidateValues = pairs.map((pair) => pair.candidate);
    baseline[metric] = summed.has(metric) ? baselineValues.reduce((sum, value) => sum + value, 0) : median(baselineValues);
    candidate[metric] = summed.has(metric) ? candidateValues.reduce((sum, value) => sum + value, 0) : median(candidateValues);
    improvements[metric] = improvementPct(baseline[metric], candidate[metric]);
    availability[metric] = { complete: true, pairedSamples: pairs.length, unavailableReason: null };
  }
  return { baseline, candidate, improvements, availability };
}

function categoryPasses(runs) {
  const byTask = new Map();
  for (const run of runs) {
    const previous = byTask.get(run.taskId) || { category: run.category, pass: true };
    previous.pass = previous.pass && run.deterministicPass;
    byTask.set(run.taskId, previous);
  }
  const result = {};
  for (const value of byTask.values()) {
    if (!value.pass) continue;
    result[value.category] = (result[value.category] || 0) + 1;
  }
  return { counts: result, total: [...byTask.values()].filter((value) => value.pass).length };
}

function sideEffectTotal(runs) {
  return runs.reduce((sum, run) => sum + SIDE_EFFECT_KEYS.reduce((inner, key) => inner + run.sideEffects[key], 0), 0);
}

function summarizeCandidate(experiment, baselineRuns, candidateResult, baselineIndex, candidateIndex) {
  const gates = experiment.profile.value.qualityGates;
  const baselinePasses = categoryPasses(baselineRuns);
  const candidatePasses = categoryPasses(candidateResult.runs);
  const blindWins = candidateResult.judgments.filter((item) => item.verdict === "candidate").length;
  const blindLosses = candidateResult.judgments.filter((item) => item.verdict === "baseline").length;
  const blindTies = candidateResult.judgments.filter((item) => item.verdict === "tie").length;
  const blindNonInferior = blindWins + blindTies;
  const pairedMetrics = pairedMetricSummary(baselineIndex, candidateIndex);
  const baselineMetrics = pairedMetrics.baseline;
  const candidateMetrics = pairedMetrics.candidate;
  const improvements = pairedMetrics.improvements;
  const categoriesPassed = Object.entries(gates.requiredCategoryPasses).every(([category, required]) => (candidatePasses.counts[category] || 0) >= required);
  const hardSideEffects = sideEffectTotal(candidateResult.runs);
  const deterministicGate = categoriesPassed && candidatePasses.total >= baselinePasses.total;
  const blindGate = blindNonInferior >= gates.minBlindNonInferior && blindLosses <= gates.maxBlindLosses;
  const qualityImproved = blindWins - blindLosses >= gates.minBlindNetWins;
  const efficiencyImproved = {
    inputTokens: improvements.inputTokens !== null && improvements.inputTokens >= gates.minInputTokenImprovementPct,
    tools: [improvements.toolCalls, improvements.repeatedReads].some((value) => value !== null && value >= gates.minToolImprovementPct),
    latency: experiment.repetitions >= 3 && improvements.latencyMs !== null && improvements.latencyMs >= gates.minLatencyImprovementPct,
  };
  const regressionKeys = ["inputTokens", "outputTokens", "reasoningTokens", "toolCalls", "repeatedReads", "toolErrors", "retries", "latencyMs"];
  const incompleteGuardrails = regressionKeys.filter((key) => pairedMetrics.availability[key].complete === false);
  const materialRegressions = regressionKeys.filter((key) => (
    (improvements[key] !== null && improvements[key] < -gates.maxOtherRegressionPct)
    || (baselineMetrics[key] === 0 && candidateMetrics[key] !== null && candidateMetrics[key] > 0)
  ));
  const meaningfulGain = qualityImproved || Object.values(efficiencyImproved).some(Boolean);
  const qualityGatePassed = hardSideEffects === 0 && deterministicGate && blindGate;
  let classification = "no_proven_gain";
  if (qualityGatePassed && meaningfulGain && (materialRegressions.length || incompleteGuardrails.length)) classification = "human_review_required";
  else if (qualityGatePassed && meaningfulGain) classification = qualityImproved ? "quality_improved" : "efficiency_improved";
  return {
    id: candidateResult.id,
    classification,
    eligible: ["quality_improved", "efficiency_improved"].includes(classification),
    gates: {
      hardSideEffects,
      deterministicGate,
      categoriesPassed,
      blindGate,
      blindNonInferior,
      blindWins,
      blindLosses,
      blindTies,
      blindNetWins: blindWins - blindLosses,
      materialRegressions,
      incompleteGuardrails,
    },
    taskPasses: candidatePasses,
    baselineTaskPasses: baselinePasses,
    metrics: {
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      improvementPct: improvements,
      availability: pairedMetrics.availability,
      aggregation: {
        inputTokens: "median",
        cachedInputTokens: "median",
        outputTokens: "median",
        reasoningTokens: "median",
        latencyMs: "median-measureLatency-tasks-only",
        toolCalls: "sum",
        repeatedReads: "sum",
        toolErrors: "sum",
        retries: "sum"
      },
    },
    improvement: { qualityImproved, ...efficiencyImproved },
  };
}

function dominates(left, right) {
  if (left.gates.blindNetWins < right.gates.blindNetWins) return false;
  const keys = ["inputTokens", "toolCalls", "repeatedReads", "latencyMs"];
  let strict = left.gates.blindNetWins > right.gates.blindNetWins;
  for (const key of keys) {
    const l = left.metrics.improvementPct[key];
    const r = right.metrics.improvementPct[key];
    if (l === null || r === null) return false;
    if (l < r) return false;
    if (l > r) strict = true;
  }
  return strict;
}

export function selectExperiment(options = {}) {
  const experimentPath = path.resolve(options.experimentPath || "");
  const candidatePath = path.resolve(options.candidatePath || "");
  const resultPath = path.resolve(options.resultPath || "");
  const experimentArtifact = readPrivateJsonArtifact(experimentPath);
  const candidateArtifact = readPrivateJsonArtifact(candidatePath);
  const resultArtifact = readPrivateJsonArtifact(resultPath);
  const experiment = validateExperiment(experimentArtifact.value);
  const candidate = validateCandidate(candidateArtifact.value, experiment);
  const result = validateResult(resultArtifact.value);
  assert(experimentArtifact.sha256 === result.experiment.sha256, "Experiment artifact changed after the run was recorded.");
  assert(candidateArtifact.sha256 === result.candidate.sha256, "Candidate artifact changed after the run was recorded.");
  assert(result.experiment.experimentSha256 === experiment.experimentSha256, "Result belongs to a different experiment.");
  assert(result.candidate.candidateSha256 === candidate.candidateSha256, "Result belongs to a different candidate artifact.");
  assert(candidate.snapshotSha256 === experiment.snapshot.snapshotSha256, "Candidate belongs to a different snapshot.");
  const frozenTarget = targetFromExperiment(experiment, candidate.target.path);
  assert(frozenTarget.root === path.resolve(candidate.target.root), "Candidate target root differs from the frozen snapshot root.");
  assert(frozenTarget.currentSha256 === candidate.target.expectedSha256, "Candidate target differs from its frozen target hash.");
  assert(frozenTarget.surface.kind === candidate.target.kind, "Candidate target kind differs from the frozen snapshot surface.");
  const frozenEvidence = validateFrozenEvidence(experiment, candidate, result);
  const summaries = result.candidates.map((item) => summarizeCandidate(
    experiment,
    result.baselineRuns,
    item,
    frozenEvidence.baseline,
    frozenEvidence.candidates.get(item.id),
  ));
  const eligible = summaries.filter((item) => item.eligible);
  let selected = null;
  let status = "no_promotion";
  if (eligible.length === 1) {
    selected = eligible[0];
    status = "selected";
  } else if (eligible.length > 1) {
    const dominators = eligible.filter((item) => eligible.every((other) => item === other || dominates(item, other)));
    if (dominators.length === 1) {
      selected = dominators[0];
      status = "selected";
    } else {
      status = "human_review_required";
    }
  } else if (summaries.some((item) => item.classification === "human_review_required")) {
    status = "human_review_required";
  }
  const report = {
    schema: SCHEMAS.selection,
    generatedAt: timestamp(),
    tool: `contextlean/${V2_VERSION}`,
    status,
    experimentSha256: experiment.experimentSha256,
    candidateSha256: candidate.candidateSha256,
    resultSha256: result.resultSha256,
    selectedCandidateId: selected?.id || null,
    candidates: summaries,
    planPrepared: false,
  };
  let plan = null;
  let selectedVariant = null;
  if (selected) {
    selectedVariant = candidate.variants.find((item) => item.id === selected.id);
    const target = resolveInside(candidate.target.root, candidate.target.path);
    assert(fileSha256(target) === candidate.target.expectedSha256, "Target changed after candidate generation; refusing to create a stale plan.");
    report.planPrepared = true;
  }
  report.selectionSha256 = hashObject(report);
  if (selected) {
    plan = {
      schemaVersion: 1,
      generatedAt: timestamp(),
      generatedBy: `contextlean/${V2_VERSION}`,
      root: candidate.target.root,
      selection: {
        reportSha256: report.selectionSha256,
        classification: selected.classification,
        candidateId: selected.id,
      },
      operations: [{
        type: "replace",
        path: candidate.target.path,
        expectedSha256: candidate.target.expectedSha256,
        contentSha256: selectedVariant.contentSha256,
        content: selectedVariant.content,
      }],
    };
  }
  return { report, plan };
}

function validateContextPackShape(pack) {
  assert(isObject(pack) && pack.schema === SCHEMAS.contextPack, `Expected ${SCHEMAS.contextPack}.`);
  assertOnlyKeys(pack, ["schema", "packId", "projectId", "permissionFingerprint", "humanReviewStatus", "canonicalSources", "builder", "tokenBudget", "chunks"], "Context Pack");
  for (const key of ["packId", "projectId", "permissionFingerprint", "humanReviewStatus"]) assertString(pack[key], `Context Pack ${key}`);
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pack.packId), "Context Pack packId must be a safe bounded label.");
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pack.projectId), "Context Pack projectId must be a safe bounded label.");
  assert(Buffer.byteLength(pack.permissionFingerprint) <= 256, "Context Pack permissionFingerprint exceeds 256 bytes.");
  assert(["candidate", "verified"].includes(pack.humanReviewStatus), "Context Pack humanReviewStatus must be candidate or verified.");
  assert(Array.isArray(pack.canonicalSources) && pack.canonicalSources.length > 0 && pack.canonicalSources.length <= 32, "Context Pack must contain 1 to 32 canonicalSources.");
  assert(isObject(pack.builder), "Context Pack builder must be an object.");
  assertOnlyKeys(pack.builder, ["parserVersion", "contentSchemaVersion", "promptSha256"], "Context Pack builder");
  for (const key of ["parserVersion", "contentSchemaVersion"]) assertString(pack.builder[key], `Context Pack builder.${key}`);
  assertSha256(pack.builder.promptSha256, "Context Pack builder.promptSha256");
  assert(Number.isInteger(pack.tokenBudget) && pack.tokenBudget > 0 && pack.tokenBudget <= 100_000, "Context Pack tokenBudget must be an integer from 1 to 100000.");
  assert(Array.isArray(pack.chunks) && pack.chunks.length > 0 && pack.chunks.length <= 128, "Context Pack must contain 1 to 128 chunks.");
  const sourceIds = new Set();
  for (const source of pack.canonicalSources) {
    assertOnlyKeys(source, ["id", "path", "sha256", "version"], "Canonical source");
    assertString(source.id, "Canonical source id");
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.id), `Canonical source id is invalid: ${source.id}`);
    assertString(source.path, `Canonical source ${source.id} path`);
    assert(Buffer.byteLength(source.path) <= 1_024, `Canonical source ${source.id} path exceeds 1024 bytes.`);
    assert(!path.isAbsolute(source.path), `Canonical source path must be relative: ${source.path}`);
    assertSafeCanonicalSourcePath(source.path);
    assertSha256(source.sha256, `Canonical source ${source.id} sha256`);
    assertString(source.version, `Canonical source ${source.id} version`);
    assert(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(source.version), `Canonical source ${source.id} version must be an opaque safe label.`);
    assert(!sourceIds.has(source.id), `Duplicate canonical source id: ${source.id}`);
    sourceIds.add(source.id);
  }
  const chunkIds = new Set();
  const chunkRanges = new Set();
  for (const chunk of pack.chunks) {
    assertOnlyKeys(chunk, ["id", "sourceId", "startLine", "endLine", "contentSha256"], "Context Pack chunk");
    assertString(chunk.id, "Context Pack chunk id");
    assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(chunk.id), `Context Pack chunk id is invalid: ${chunk.id}`);
    assert(sourceIds.has(chunk.sourceId), `Chunk ${chunk.id} refers to an unknown source.`);
    assert(Number.isInteger(chunk.startLine) && chunk.startLine >= 1, `Chunk ${chunk.id} startLine must be positive.`);
    assert(Number.isInteger(chunk.endLine) && chunk.endLine >= chunk.startLine, `Chunk ${chunk.id} endLine is invalid.`);
    assertSha256(chunk.contentSha256, `Chunk ${chunk.id} contentSha256`);
    assert(!chunkIds.has(chunk.id), `Duplicate chunk id: ${chunk.id}`);
    chunkIds.add(chunk.id);
    const rangeKey = `${chunk.sourceId}:${chunk.startLine}:${chunk.endLine}`;
    assert(!chunkRanges.has(rangeKey), `Duplicate Context Pack source range: ${rangeKey}`);
    chunkRanges.add(rangeKey);
  }
  return pack;
}

function assertSafeCanonicalSourcePath(relativePath) {
  assert(!sensitivePathFinding(relativePath), `Refusing sensitive Context Pack source path: ${relativePath}`);
}

export function readSourceVersions(filePath) {
  const resolved = path.resolve(filePath || "");
  const fileArtifact = readPrivateJsonArtifact(resolved);
  const artifact = fileArtifact.value;
  assert(isObject(artifact) && artifact.schema === SCHEMAS.sourceVersions, `Expected ${SCHEMAS.sourceVersions}.`);
  assertOnlyKeys(artifact, ["schema", "versions"], "Source versions artifact");
  assert(isObject(artifact.versions) && Object.keys(artifact.versions).length > 0, "Source versions artifact must contain versions.");
  for (const [sourceId, version] of Object.entries(artifact.versions)) {
    assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId), `Invalid source version id: ${sourceId}`);
    assertString(version, `Source version ${sourceId}`);
    assert(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(version), `Source version ${sourceId} must be an opaque safe label.`);
  }
  return { path: resolved, sha256: fileArtifact.sha256, versions: artifact.versions };
}

function inspectSourceRanges(sourcePath, ranges) {
  const stat = fs.statSync(sourcePath);
  assert(stat.size <= MAX_CANONICAL_SOURCE_BYTES, `Canonical source exceeds ${MAX_CANONICAL_SOURCE_BYTES} byte safety limit: ${sourcePath}`);
  const requested = ranges.map((range) => ({ ...range, lines: [] }));
  const digest = crypto.createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = "";
  let lineNumber = 1;
  let selectedBytes = 0;
  let descriptor;
  const handleLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    for (const range of requested) {
      if (lineNumber < range.startLine || lineNumber > range.endLine) continue;
      range.lines.push(line);
      selectedBytes += Buffer.byteLength(line) + (range.lines.length > 1 ? 1 : 0);
      assert(selectedBytes <= MAX_JSON_ARTIFACT_BYTES, `Selected Context Pack ranges exceed ${MAX_JSON_ARTIFACT_BYTES} bytes.`);
    }
    lineNumber += 1;
  };
  try {
    descriptor = fs.openSync(sourcePath, "r");
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      pending += decoder.write(bytes);
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        handleLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.end();
    handleLine(pending);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const lineCount = lineNumber - 1;
  const chunks = new Map();
  const invalidRanges = [];
  for (const range of requested) {
    if (range.endLine > lineCount) {
      invalidRanges.push(range.id);
      continue;
    }
    const content = range.lines.join("\n");
    assert(Buffer.byteLength(content) <= MAX_SELECTED_TEXT_BYTES, `Context Pack chunk ${range.id} exceeds 1 MB.`);
    chunks.set(range.id, content);
  }
  return { sha256: digest.digest("hex"), lineCount, chunks, invalidRanges };
}

export function validateContextPack(options = {}) {
  const manifestPath = path.resolve(options.manifestPath || "");
  const root = path.resolve(options.root || path.dirname(manifestPath));
  assertString(options.permissionFingerprint, "Current permission fingerprint");
  assertString(options.parserVersion, "Current parser version");
  assertString(options.contentSchemaVersion, "Current content schema version");
  assertSha256(options.promptSha256, "Current prompt SHA-256");
  const sourceVersions = readSourceVersions(options.sourceVersionsPath);
  const pack = validateContextPackShape(readPrivateJson(manifestPath));
  const staleReasons = [];
  if (pack.permissionFingerprint !== options.permissionFingerprint) staleReasons.push("permission-fingerprint-changed");
  if (pack.builder.parserVersion !== options.parserVersion) staleReasons.push("parser-version-changed");
  if (pack.builder.contentSchemaVersion !== options.contentSchemaVersion) staleReasons.push("content-schema-version-changed");
  if (pack.builder.promptSha256 !== options.promptSha256) staleReasons.push("prompt-version-changed");
  for (const source of pack.canonicalSources) {
    if (!Object.hasOwn(sourceVersions.versions, source.id)) staleReasons.push(`source-version-unavailable:${source.id}`);
    else if (sourceVersions.versions[source.id] !== source.version) staleReasons.push(`source-version-changed:${source.id}`);
  }
  const resolvedSources = new Map();
  for (const source of pack.canonicalSources) {
    const ranges = pack.chunks.filter((chunk) => chunk.sourceId === source.id);
    const sourcePath = resolveInside(root, source.path);
    if (!existingRegularFile(sourcePath)) {
      staleReasons.push(`source-unavailable:${source.id}`);
      continue;
    }
    const inspected = inspectSourceRanges(sourcePath, ranges);
    if (inspected.sha256 !== source.sha256) staleReasons.push(`source-hash-changed:${source.id}`);
    for (const chunkId of inspected.invalidRanges) staleReasons.push(`chunk-range-invalid:${chunkId}`);
    resolvedSources.set(source.id, { ...source, sourcePath, inspected });
  }
  const renderedChunks = [];
  for (const chunk of pack.chunks) {
    const source = resolvedSources.get(chunk.sourceId);
    if (!source) continue;
    const content = source.inspected.chunks.get(chunk.id);
    if (content === undefined) continue;
    assertNoSensitiveText(content, `Context Pack chunk ${chunk.id}`);
    if (hashValue(content) !== chunk.contentSha256) staleReasons.push(`chunk-hash-changed:${chunk.id}`);
    renderedChunks.push({ ...chunk, sourcePath: source.path, sourceVersion: source.version, content });
  }
  const selectedContentBytes = renderedChunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.content), 0);
  const renderedContent = buildContextPackContent(pack, renderedChunks);
  const renderedBytes = Buffer.byteLength(renderedContent);
  const approximateTokens = Math.ceil(renderedBytes / 4);
  if (approximateTokens > pack.tokenBudget) staleReasons.push("token-budget-exceeded");
  return {
    schema: "contextlean.context-pack-validation/v1",
    manifestPath,
    root,
    sourceVersions: { path: sourceVersions.path, sha256: sourceVersions.sha256 },
    ok: staleReasons.length === 0,
    status: staleReasons.length ? "stale" : "current",
    staleReasons: [...new Set(staleReasons)],
    humanReviewStatus: pack.humanReviewStatus,
    metrics: { sources: pack.canonicalSources.length, chunks: pack.chunks.length, selectedContentBytes, renderedBytes, approximateTokens, tokenBudget: pack.tokenBudget },
    pack,
    renderedChunks,
    renderedContent,
  };
}

function buildContextPackContent(pack, renderedChunks) {
  const lines = [
    `# Context Pack: ${pack.packId}`,
    "",
    `Project: ${pack.projectId}`,
    `Review status: ${pack.humanReviewStatus}`,
    "Authority: derived context only; canonical sources remain authoritative.",
    "",
  ];
  for (const chunk of renderedChunks) {
    lines.push(`## ${chunk.id}`);
    lines.push(`Source: ${chunk.sourcePath}#L${chunk.startLine}-L${chunk.endLine} (version ${chunk.sourceVersion})`);
    lines.push("");
    lines.push(chunk.content);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderContextPack(options = {}) {
  const validation = validateContextPack(options);
  assert(validation.ok, `Context Pack is stale: ${validation.staleReasons.join(", ")}`);
  assert(validation.humanReviewStatus === "verified" || options.allowCandidate === true, "Candidate Context Packs require explicit --allow-candidate for evaluation.");
  return { validation, content: validation.renderedContent };
}

export function writeSnapshot(snapshot, filePath) {
  validateSnapshot(snapshot);
  return writePrivateJson(filePath, snapshot);
}

export function writeExperiment(experiment, filePath) {
  validateExperiment(experiment);
  return writePrivateJson(filePath, experiment);
}

export function writeCandidates(candidate, filePath) {
  validateCandidate(candidate);
  return writePrivateJson(filePath, candidate);
}

export function writeExperimentResult(result, filePath) {
  validateResult(result);
  return writePrivateJson(filePath, result);
}

export function writeSelection(selection, reportPath, planPath) {
  const writtenReport = writePrivateJson(reportPath, selection.report);
  let writtenPlan = null;
  if (selection.plan && planPath) writtenPlan = writePrivateJson(planPath, selection.plan);
  return { reportPath: writtenReport, planPath: writtenPlan };
}

export function writeRenderedPack(rendered, filePath) {
  return writePrivateText(filePath, rendered.content);
}

export { SCHEMAS };
