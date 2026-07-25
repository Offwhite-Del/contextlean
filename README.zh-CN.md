# ContextLean

面向本地 AI Agent 运行环境的、可回滚的上下文与配置体检工具。

ContextLean 帮助 ChatGPT/Codex、Claude Code 及兼容 Agent Skills 的客户端减少重复规则、无关能力、空转 hooks 和跨平台配置冲突。它优化的是可控的 Agent harness，不修改模型，也不承诺加速模型厂商服务器上的推理。

> 当前版本：`0.1.0`。已实现只读审计，以及带哈希保护的 apply、verify、rollback 闭环。

## 能做什么

- 测量 `AGENTS.md`、`CLAUDE.md` 等常驻指令文件。
- 检测过大的规则面和跨文件完全重复行，但不打印规则内容。
- 统计当前范围内的 Skills 和已启用插件。
- 检测空转的 Codex hooks 和跨厂商环境变量键名。
- 生成带 SHA-256 的优化计划骨架。
- 只执行经过审阅、显式 `--yes` 确认的规则/Skill 完整替换。
- 自动备份、写回回执、验证结果并精确回滚。
- 本地运行、零遥测、Node.js 18+ 零运行时依赖。

## 不做什么

- 不读取认证文件、钥匙串、`.env` 或私人 Agent 会话。
- 不上传配置、提示词、代码、报告或遥测。
- 不删除文件，不安装后台服务，不默认启用 hooks/MCP。
- 不把“更短”自动判定为“更好”。
- 不承诺发挥模型 100% 能力，也不能消除服务端和网络延迟。

## 快速使用

```bash
npx --yes github:Offwhite-Del/contextlean audit --scope repo
npx --yes github:Offwhite-Del/contextlean doctor
```

本地开发：

```bash
git clone https://github.com/Offwhite-Del/contextlean.git
cd contextlean
npm test
node bin/contextlean.mjs doctor
```

`audit` 默认只审计当前仓库；`doctor` 同时审计仓库和用户级 Agent 配置。两者都不会修改文件。

## ChatGPT Desktop / Codex 安装

```bash
codex plugin marketplace add Offwhite-Del/contextlean \
  --sparse .agents/plugins \
  --sparse plugins
codex plugin add contextlean@contextlean
```

重启 ChatGPT 桌面端或新建 Codex CLI 会话后，使用 `$optimize-agent-context`。

## Claude Code / Claude Code Desktop 安装

```bash
claude plugin marketplace add Offwhite-Del/contextlean \
  --sparse .claude-plugin plugins
claude plugin install contextlean@contextlean
```

重载插件或新建会话后，使用 `/contextlean:optimize-agent-context`。

## 其他 Agent

通用 Skill 位于：

```text
plugins/contextlean/skills/optimize-agent-context/
```

可以使用目标客户端的 Agent Skills 安装器，或复制到它支持的 Skill 目录。`SKILL.md`、参考说明和 CLI 在 Codex 与 Claude 插件中共用一份，避免双份规则漂移。

## 安全变更流程

```bash
contextlean audit --root . --json
contextlean plan --root . --write .contextlean/plan.json
contextlean apply --plan .contextlean/plan.json --yes
contextlean verify --receipt .contextlean/backups/<id>/receipt.json
contextlean rollback --receipt .contextlean/backups/<id>/receipt.json --yes
```

计划只允许带当前 SHA-256 的 `replace` 操作。0.1 版仅允许已知规则文件名和 `SKILL.md`；配置发现只给建议，不自动覆盖可能含凭证或其他运行行为的配置文件。文件在计划生成后发生变化时，ContextLean 会拒绝执行，而不是覆盖新内容。

## 判断标准

ContextLean 追求的不是最短上下文，而是：

> 在可接受的响应时间和成本下，提高真实任务成功率，并保留恢复能力。

约算 token 使用 `bytes / 4`，阈值只是审查提示。只有相同代表任务的质量、工具行为和必要证据仍然通过，减少 token 才算真正优化。

## 初始实证

首个真实案例把常驻规则从 6,148 字节降到 3,191 字节（减少 48.1%），相同简单 Codex 提示减少 751 个输入 tokens。单次延迟也有下降，但受网络与缓存影响，不构成产品性能保证。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
