# Security policy / 安全策略

ContextLean changes files only through an explicit, reviewed plan with expected SHA-256 hashes. It creates a local backup and receipt before reporting success.

ContextLean 只通过经过审阅、显式确认并携带预期 SHA-256 的计划修改文件；报告成功前会创建本地备份和回执。

## Data boundary / 数据边界

ContextLean does not read / ContextLean 不读取：

- Agent authentication files, keychains, `.env` files, or credential stores / Agent 认证文件、钥匙串、`.env` 或凭证存储；
- private Agent session transcripts / 私人 Agent 会话；
- source code beyond known instruction and configuration surfaces / 已知指令与配置面之外的源代码。

Supported configuration is parsed locally, but reports include key names only where needed and never include configuration values. ContextLean does not upload configuration, reports, or secret values.

受支持的配置只在本地解析；报告仅在必要时包含键名，绝不包含配置值。ContextLean 不上传配置、报告或密钥值。

Reports stay local. Do not publish `.contextlean/` plans, backups, or receipts without a separate redaction review.

报告保留在本地。未经单独脱敏审查，不要公开 `.contextlean/` 中的计划、备份或回执。

## Reporting a vulnerability / 报告漏洞

Use [GitHub private vulnerability reporting](https://github.com/Offwhite-Del/contextlean/security/advisories/new). Do not put credentials, private configuration, exploit secrets, or user data in a public issue.

请使用 [GitHub 私密漏洞报告](https://github.com/Offwhite-Del/contextlean/security/advisories/new)。不要在公开 Issue 中提交凭证、私人配置、漏洞机密或用户数据。

Include the ContextLean version, operating system, affected command, minimal reproduction, and expected safety boundary. Revoke any exposed credential before reporting.

请提供 ContextLean 版本、操作系统、受影响命令、最小复现和预期安全边界。报告前先撤销任何已暴露凭证。

## Supported versions / 支持版本

Security fixes target the latest tagged release. This project is pre-1.0; review plans and backups before every mutation.

安全修复面向最新标签版本。本项目尚未到 1.0；每次写入前都应审阅计划和备份。
