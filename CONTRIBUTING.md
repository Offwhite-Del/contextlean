# Contributing / 参与贡献

[English](#english) · [简体中文](#简体中文)

## English

ContextLean welcomes reproducible bug reports and small, evidence-backed improvements. Keep the project local-only, zero-telemetry, dependency-free at runtime, and read-only by default.

### Before opening an issue

- Search existing issues and remove private paths, configuration values, secrets, and `.contextlean/` artifacts from examples.
- Use the bug or feature template and describe the Agent client, operating system, ContextLean version, expected behavior, and minimal reproduction.
- Report security issues privately as described in [SECURITY.md](SECURITY.md).

### Pull requests

1. Fork the repository and create a focused branch.
2. Match the existing JavaScript style and keep deterministic safeguards in code and tests.
3. Run:

   ```bash
   npm ci
   npm test
   npm run validate
   npm pack --dry-run
   ```

4. Update both `README.md` and `README.zh-CN.md` when user-facing behavior changes.
5. Explain the problem, scope, evidence, risks, and rollback path in the pull request.

Changes that read private transcripts, collect telemetry, weaken hash/confirmation/backup safeguards, or add an always-on service are outside the current project boundary.

## 简体中文

ContextLean 欢迎可复现的缺陷报告和范围小、有证据支持的改进。项目必须保持本地运行、零遥测、运行时零依赖并默认只读。

### 提交 Issue 前

- 先搜索现有 Issue，并从示例中删除私人路径、配置值、密钥和 `.contextlean/` 产物。
- 使用缺陷或功能模板，写清 Agent 客户端、操作系统、ContextLean 版本、预期行为和最小复现。
- 安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

### 提交 Pull Request

1. Fork 仓库并创建范围明确的分支。
2. 匹配现有 JavaScript 风格，把确定性安全约束放进代码和测试。
3. 运行：

   ```bash
   npm ci
   npm test
   npm run validate
   npm pack --dry-run
   ```

4. 用户可见行为变化时，同时更新 `README.md` 与 `README.zh-CN.md`。
5. 在 Pull Request 中说明问题、范围、证据、风险和回滚路径。

读取私人会话、收集遥测、削弱哈希/确认/备份保护或增加常驻服务的变更，不属于当前项目边界。
