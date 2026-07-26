# Security policy / 安全策略

ContextLean changes files only through an explicit, reviewed plan with expected SHA-256 hashes. It creates a local backup and receipt before reporting success.

ContextLean 只通过经过审阅、显式确认并携带预期 SHA-256 的计划修改文件；报告成功前会创建本地备份和回执。

## Data boundary / 数据边界

By default, ContextLean does not read / 默认情况下 ContextLean 不读取：

- Agent authentication files, keychains, `.env` files, or credential stores / Agent 认证文件、钥匙串、`.env` 或凭证存储；
- private Agent session transcripts / 私人 Agent 会话；
- source code beyond known instruction and configuration surfaces / 已知指令与配置面之外的源代码。

`experiment generate` reads exactly one user-selected instruction or `SKILL.md` target. Context Pack validation streams each manifest-declared canonical source to compute its full SHA-256, while materializing only exact cited line ranges. It also requires a separate current source-version artifact. Both paths reject known sensitive path categories and credential-like selected text, but pattern checks do not make confidential material safe to share.

`experiment generate` 只读取一个用户明确选择的规则或 `SKILL.md`；Context Pack 验证会流式读取 manifest 声明的 canonical 来源以计算完整 SHA-256，但只把精确引用行物化到内存，同时强制提供独立的当前 source-version 产物。两条路径都会拒绝已知敏感路径类别与凭证形态文本，但模式检查不能把机密资料变成可安全共享的数据。

Supported configuration is parsed locally, but reports include key names only where needed and never include configuration values. ContextLean itself does not upload configuration, reports, or secret values.

受支持的配置只在本地解析；报告仅在必要时包含键名，绝不包含配置值。ContextLean 本身不上传配置、报告或密钥值。

## Adapter boundary / Adapter 边界

Experiment adapters are user-supplied subprocesses, not a ContextLean model service. ContextLean sends the selected target and non-held-out tasks to the optimizer, task/context pairs to the runner, and anonymous outputs to the judge. An Agent adapter may transmit that request to its configured provider. Review and authorize the adapter/provider data path before running it.

实验 adapter 是用户提供的子进程，不是 ContextLean 模型服务。ContextLean 会把选定目标与非 held-out 任务交给 optimizer，把任务/上下文交给 runner，把匿名输出交给 judge。Agent adapter 可能把请求传给其已配置 provider；运行前必须单独复核并授权 adapter/provider 数据路径。

Adapter specs cannot contain environment values or credentials. ContextLean strips credential-like variables and all proxy environment variables, streams bounded executable/code-file argv fingerprints while refusing sensitive file paths, requires runner output to match a passing sandbox qualification receipt, and rejects binding or observed-environment drift during selection. These controls do not make an untrusted adapter safe; run only reviewed adapters.

Adapter spec 不得包含环境值或凭证。ContextLean 会剔除凭证形态变量和全部代理环境变量，以流式 SHA-256 绑定有界的 executable/code argv 文件并拒绝敏感路径，要求 runner 输出匹配通过的沙箱资格回执，并在选优时拒绝绑定或实际环境漂移。这些控制不能把不受信任的 adapter 变安全；只运行已审阅 adapter。

On POSIX, private artifacts are created with mode `0600`. Windows does not provide POSIX mode semantics; ContextLean inherits the containing directory ACL there. Use a user-private artifact directory on every platform.

POSIX 上私有产物以 `0600` 创建；Windows 不提供 POSIX mode 语义，ContextLean 会继承所在目录 ACL。所有平台都应使用用户私有产物目录。

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
