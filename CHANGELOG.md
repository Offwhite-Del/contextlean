# Changelog / 变更日志

All notable changes are documented here. / 重要版本变化记录在这里。

## [Unreleased]

### Added / 新增

- Added metadata-only context snapshots, bounded optimizer/runner/judge adapters, frozen A/B experiments, quality-first Pareto selection, and v1-plan output for proven winners.
- Added source-backed Context Pack validation/rendering with causal invalidation for source, parser, schema, prompt, permission, citation, and token-budget changes.
- Added public schemas with executable AJV validation, plus separate smoke/full profiles and 6-task/24-task evaluation fixtures.
- Added frozen adapter/sandbox/environment bindings, assertion-blind runners, paired metric aggregation, and hash-only persistence for judge rationales.
- 新增仅元数据上下文快照、受限 adapter、冻结 A/B、质量优先 Pareto 选优，以及仅为已证明候选生成 v1 plan 的闭环。
- 新增来源绑定 Context Pack 的因果失效验证、可执行 AJV schema 校验、独立 smoke/full profile、6 项烟雾任务和 24 项冻结任务。
- 新增 adapter/沙箱/环境冻结、runner 断言隔离、成对指标聚合和盲审理由仅哈希落盘。

### Changed / 变更

- Evolved the bundled Skill from context reduction toward evidence-driven relevance, freshness, trigger, tool-behavior, and recovery optimization.
- Context Packs now require an independent current source-version artifact and stream sources for hashing while materializing only cited ranges.
- Adapter subprocesses no longer inherit proxy environment variables; POSIX `0600` and Windows inherited-ACL behavior are documented separately.
- 将 Skill 从单纯压缩升级为对相关性、时效性、触发、工具行为和恢复能力的证据驱动优化。
- Context Pack 现在强制独立 source-version 产物，并以流式哈希加引用范围物化验证；adapter 不再继承代理变量，POSIX 与 Windows 权限语义分别说明。

- Reworked the English and Simplified Chinese repository presentation for full content parity.
- Added community contribution files, structured issue forms, and a pull request template.
- Added adaptive light/dark repository artwork and a reproducible audit-output example.
- 增加中英文对等的仓库首页、社区协作文件、结构化 Issue 表单和 Pull Request 模板。
- 增加自适应明暗主题的仓库视觉资产与可复现审计输出示例。

## [0.1.0] - 2026-07-26

### Added / 新增

- Local read-only audits for known Agent instruction and configuration surfaces.
- Hash-guarded plan, apply, verify, and exact rollback workflow.
- Portable `optimize-agent-context` Skill and Codex/Claude plugin manifests.
- Node.js 18/20/22 tests on Linux, macOS, and Windows.
- 本地只读审计、哈希保护的变更与回滚闭环、通用 Skill，以及 Codex/Claude 插件支持。

[Unreleased]: https://github.com/Offwhite-Del/contextlean/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Offwhite-Del/contextlean/releases/tag/v0.1.0
