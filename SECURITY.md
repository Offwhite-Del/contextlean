# Security policy

ContextLean changes files only through an explicit, reviewed plan with expected SHA-256 hashes. It creates a local backup and receipt before reporting success.

## Data boundary

ContextLean does not read:

- Agent authentication files or keychains
- `.env` files or credential stores
- Private Agent session transcripts
- Source code beyond known instruction and configuration surfaces

ContextLean parses supported configuration locally but never includes configuration values in reports. It does not upload configuration, key names, reports, or secret values.

Reports stay local. Do not publish `.contextlean/` plans, backups, or receipts without a separate redaction review.

## Reporting a vulnerability

Open a GitHub security advisory for the repository. Do not put credentials, private configuration, exploit secrets, or user data in a public issue.

Include the ContextLean version, operating system, affected command, minimal reproduction, and expected safety boundary. Revoke any exposed credential before reporting it.

## Supported versions

Security fixes target the latest tagged release. This project is pre-1.0; review plans and backups before every mutation.
