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
      "content": "complete replacement content"
    }
  ]
}
```

Keep plans under `.contextlean/`, which should stay out of version control. Review the complete replacement content before running `apply --yes`. Version 0.1 accepts only known instruction filenames and `SKILL.md`; configuration findings remain advisory because configuration files may contain credentials or unrelated runtime behavior.

## Validation

Use at least one realistic task. A smaller file, successful command, or lower token count is not sufficient. Verify task quality, required evidence, tool behavior, latency, and recovery. Record single-run measurements as samples rather than guarantees.
