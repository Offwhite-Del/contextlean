<div align="center">
  <img src="assets/contextlean-hero.svg" alt="ContextLean — 测量、精简、验证、回滚" width="100%">
</div>

<div align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</div>

<div align="center">
  <a href="https://github.com/Offwhite-Del/contextlean/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Offwhite-Del/contextlean/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Offwhite-Del/contextlean/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Offwhite-Del/contextlean?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/github/license/Offwhite-Del/contextlean"></a>
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white">
</div>

ContextLean 是面向 AI 编程 Agent 的本地、可回滚上下文与配置体检工具。它帮助 Codex、ChatGPT 桌面端、Claude Code 和其他兼容 Agent Skills 的客户端减少 Agent 运行框架中可避免的负担，但不会假装能够加速模型厂商的服务端推理。

> **当前状态：** `v0.1.0` 已实现只读审计，以及带哈希保护的 plan/apply/verify/rollback 闭环。所有阈值都是保守的审查提示，不是通用质量标准。

## 为什么需要 ContextLean

Agent 的实际表现由两个不同层面共同决定：

| 层面 | ContextLean 可以改善 | ContextLean 无法改变 |
| --- | --- | --- |
| 本地 Agent 运行框架 | 常驻指令、已发现的 Skills、已启用插件、空转 hooks、跨厂商配置 | — |
| 模型服务商 | — | 推理速度、容量、路由、限流和模型能力 |

ContextLean 把可控层变得可测量、可回滚。只有代表性任务仍然通过，更短的上下文才算真正改善。

## 它如何工作

1. **测量**已知指令面，不广泛读取项目源代码。
2. **诊断**过大的规则、完全重复行、Skill/插件负载、空转 Codex hooks 和跨厂商环境变量键名。
3. **规划**带源文件 SHA-256 的待审阅替换方案。
4. **安全执行**：只有显式确认后才写入，并生成备份和回执。
5. **验证或回滚**：使用写入后哈希和备份哈希精确核验。

全部操作在本地完成，零遥测；除 Node.js 18+ 外没有运行时依赖。

## 快速开始

直接从 GitHub 运行：

```bash
npx --yes github:Offwhite-Del/contextlean audit --scope repo
npx --yes github:Offwhite-Del/contextlean doctor
```

或者克隆后在本地验证：

```bash
git clone https://github.com/Offwhite-Del/contextlean.git
cd contextlean
npm test
node bin/contextlean.mjs doctor
```

`audit` 默认只审计当前仓库；`doctor` 同时审计仓库和用户级 Agent 配置。两者都不会修改文件。

## 命令

```text
contextlean audit [--root PATH] [--scope repo|home|all] [--json]
contextlean doctor [--root PATH] [--home PATH] [--json]
contextlean plan [--root PATH] [--scope repo|home|all] [--write FILE]
contextlean apply --plan FILE --yes [--root PATH]
contextlean verify --receipt FILE [--json]
contextlean rollback --receipt FILE --yes
```

## 作为 Agent Skill 安装

### ChatGPT 桌面端和 Codex

```bash
codex plugin marketplace add Offwhite-Del/contextlean \
  --sparse .agents/plugins \
  --sparse plugins
codex plugin add contextlean@contextlean
```

重启 ChatGPT 桌面端或新建 Codex CLI 会话，然后调用 `$optimize-agent-context`，也可以直接要求 Codex 审计 Agent 环境。

### Claude Code 和 Claude Code Desktop

```bash
claude plugin marketplace add Offwhite-Del/contextlean \
  --sparse .claude-plugin plugins
claude plugin install contextlean@contextlean
```

重载插件或新建会话，然后调用 `/contextlean:optimize-agent-context`，也可以直接要求 Claude 审计 Agent 环境。

### 其他 Agent Skills 客户端

可移植 Skill 位于 [`plugins/contextlean/skills/optimize-agent-context/`](plugins/contextlean/skills/optimize-agent-context/)。使用目标客户端的 Skill 安装器，或复制到它支持的 Skill 目录即可。Codex 与 Claude 插件共用同一份 Skill、参考说明和 CLI 实现，避免双份规则漂移。

## 安全变更流程

```bash
contextlean audit --root . --json
contextlean plan --root . --write .contextlean/plan.json
# 审阅并补全计划中的 replace 操作。
contextlean apply --plan .contextlean/plan.json --yes
contextlean verify --receipt .contextlean/backups/<id>/receipt.json
contextlean rollback --receipt .contextlean/backups/<id>/receipt.json --yes
```

0.1 版只接受已知规则文件名和 `SKILL.md` 的完整替换。每个操作必须携带当前 SHA-256；如果源文件在计划生成后发生变化，ContextLean 会拒绝覆盖。配置类发现只提供建议。

## 安全边界

ContextLean **不会**：

- 读取认证文件、钥匙串、`.env`、密钥值或私人 Agent 会话；
- 上传提示词、配置、代码、报告或遥测；
- 删除文件、安装服务、启用 hooks 或添加 MCP 服务器；
- 自动判定“指令越短越好”；
- 承诺“发挥模型 100% 能力”或消除模型服务商与网络延迟。

计划、备份和回执保存在 `.contextlean/`，默认已被 Git 忽略。分享前仍应单独进行脱敏审查。

## 方法与初始实证

CLI 负责确定性工作：测量、哈希、备份、精确写入、验证和恢复。Skill 负责上下文判断：哪些边界必须保留、哪些细节可以按需加载，以及哪些代表性任务必须继续通过。

首个真实案例把常驻规则从 6,148 字节降到 3,191 字节（减少 48.1%），相同简单 Codex 提示减少 751 个输入 tokens。单次延迟也有下降，但受网络与缓存影响，**不构成**产品基准或性能保证。

## 相关项目

- [PrismoDev](https://github.com/shanirsh/prismodev) 侧重本地会话可观测性、token 浪费、噪声输出和会话后期验证。
- [ECC](https://github.com/affaan-m/ECC) 提供覆盖面较广的跨 Agent Skills、hooks、规则和编排能力集合。
- [OpenSSF Scorecard](https://github.com/ossf/scorecard) 衡量开源项目的安全实践，可以补充 ContextLean，但不负责优化 Agent 上下文。

ContextLean 刻意保持窄范围：诊断本地 Agent 配置，让经过审阅的变更可回滚；不读取私人会话，也不增加新的运行时控制平面。

## 项目结构

```text
bin/contextlean.mjs                         CLI 入口
plugins/contextlean/                       Codex 与 Claude 插件包
  skills/optimize-agent-context/           可移植 Agent Skill
test/contextlean.test.mjs                  跨平台行为测试
.agents/plugins/marketplace.json           Codex marketplace
.claude-plugin/marketplace.json            Claude marketplace
```

## 参与贡献

欢迎提交可复现的缺陷和范围明确的改进。提交 Issue 或 Pull Request 前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。版本变化记录在 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
