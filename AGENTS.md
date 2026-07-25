# ContextLean contributor guidance

- Keep the CLI local-only, zero-telemetry, dependency-free, and read-only by default.
- Never inspect auth files, keychains, private session transcripts, `.env` files, or secret values.
- Put deterministic constraints in code and tests; keep the bundled Skill concise and procedural.
- Require hashes, explicit confirmation, backups, verification, and rollback for every mutation.
- Run `npm test`, both plugin validators, and the Skill validator before release.
