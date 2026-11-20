# DSH 0.2.2-rc.3 内置 SDK 插件清单

本文用于决定 DiAgent 的基础配置应保留哪些 DSH 组件，以及哪些业务能力适合按运行配置装配。清单按 DiAgent 锁定的 DSH 版本整理。

## 清单口径

在 DiAgent 本地验收镜像 `diagent-task:unified-acceptance` 中，离线执行 DSH 启动器的 `--profile sdk --dump-default-config`，核对版本为 `0.2.2-rc.3`，得到 **115 个顶层配置项**。该命令解析配置，未启动 Agent。一个配置项可以提供内部服务、依赖或多个工具。最终模型收到的工具还取决于运行时条件和 DiAgent 的工具限制。DSH 自带的其他 profile 可选用不同的 bundle，115 只适用于本次采用的 `sdk`。 [官方固定版本 CLI 说明](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/apps/cli/reference/README.md) · [锁文件](../../package-lock.json)

同一镜像按相同方法导出了其他内置 profile。`sdk-minimal` 37 条、`web` 202 条、`headless` 和 `acp` 各 101 条，以下逐项清单以 DiAgent 采用的 `sdk` 为准。

原版 `sdk` 由 `dsh-base` 与 `sdk-app` 组成。启动时可叠加 profile、home 和调用指定的补丁，后续配置可按 ID 新增、修改或禁用配置项。配置项之间存在服务依赖，逐个暴露开关容易产生无法启动或丢失行为的组合。建议先保留运行基础，只为任务提供明确需要的业务能力。 [基础 bundle](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/packages/bundle/base/cordis.patch.yml) · [SDK bundle](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/packages/bundle/sdk-app/cordis.patch.yml)

## 原版 SDK 的 115 个配置项

每项只列一次。末列是面向当前 DiAgent 的取舍建议，功能分组不表示独立加载边界。

| 范围 | 配置项 ID | DiAgent 取舍 |
| --- | --- | --- |
| 会话与 SDK 接口（14） | `timer`、`typert`、`typert-loader`、`typert-gateway`、`remote-access`、`agent`、`agent-default-model`、`jobs`、`sdk-app-startup`、`sdk-jsonrpc-server`、`tools`、`tool-executor-native`、`agent-loop`、`timeout-policy` | 保留。SDK 启动与 JSON-RPC、Agent 循环、工具注册和执行、超时等是现有执行链路。服务端依赖要随所用组合一起检查。 |
| 模型与凭据（9） | `llm`、`deepseek-llm-api-extensions`、`llm-retry`、`authorization`、`deepseek-account`、`credentials`、`llm-pi-ai`、`llm-deepseek`、`llm-deepseek-account` | 保留模型执行和 `llm-pi-ai`。DiAgent 显式选择自建 `diagent-model` 路由，原生 DeepSeek 账号和专用路由目前无明确调用需求。整组调整前验证凭据、模型解析和工具续轮。 |
| 会话记录与上下文（18） | `session`、`session-title`、`session-title-llm`、`session-persistence-jsonl`、`attachment-local`、`session-query-sqlite`、`session-projection`、`storage`、`storage-json`、`storage-domain`、`session-projection-cache`、`token-meter`、`compaction-basic`、`spill-local`、`spill-policy`、`session-checkpoint-policy`、`tool-result-pruner`、`image-offload` | 保留现有会话与上下文策略。持久化、投影和 checkpoint 与执行链路有关。是否注入 DiOS 的上一轮消息属于 DiAgent 请求装配。标题、查询和图片组件的精简留待验证。 |
| 权限、工作区和命令执行（18） | `subprocess`、`sandbox`、`sandbox-policy`、`bash-sandbox`、`pwsh-sandbox`、`approval`、`permission`、`shell-env`、`tool-bash`、`tool-pwsh`、`tool-jobs`、`fs-observation-policy`、`tool-fs`、`tool-fs-search`、`working-directory`、`tool-working-directory`、`fs-sandbox`、`workspace` | 保留权限与隔离组件。Shell、文件读写和搜索按用例开放，后台作业和目录管理工具另行按需。保留 `shell` 时必须保留它内部委派的 Bash 执行链。 |
| 角色、Skills 与交互（10） | `agent-instructions`、`skill`、`skill-filesystem`、`tool-skill`、`commands`、`command-feedback`、`user-questions`、`tool-ask-user`、`system-prompt`、`time-context` | 角色提示保留。Skills 按 Agent 配置。工作区指令读取、人工询问和交互命令按使用场景决定，区分 DSH 自带人工交互与 DiOS 事件审批。 |
| 目标、子 Agent 与工作流（22） | `goal`、`goal-round-driver`、`command-goal`、`plan-mode`、`command-compact`、`subagent`、`agent-team`、`tool-agent-team`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`tool-subagent-control`、`tool-subagent`、`tool-subagent-fork`、`ptc-runtime`、`workflow-ptc`、`tool-workflow`、`tool-todo`、`tool-goal`、`repeat-tool-reminder`、`tool-executor-ptc`、`schedule`、`tool-schedule` | 业务工具先按需开放。目标、计划、团队、内部子 Agent、工具工作流和调度可作为后续整组审查对象。原 DiAgent 的具名 `subagents` 配置仍需兼容。 |
| 搜索与 MCP（6） | `web`、`web-search-deepseek`、`web-deepseek-api`、`web-fetch-http`、`tool-web`、`mcp-resources` | Web 搜索和抓取按需开放。`mcp-resources` 是原生配置行，DiAgent 根据服务器配置另行追加 MCP Client，是否关闭资源行要同时验证 MCP 工具发现和执行。 |
| Office 与交付数据（9） | `office-kit`、`tool-office`、`workspace-dependencies`、`skill-office`、`connection`、`file-upload`、`present`、`file-reference-local`、`deliverable-file-references` | Office、上传及文件交付功能按场景启用。先验证日志、结果文件和独立 API 下载，再判断 DSH 的文件引用与表现层能否关闭。 |
| 配置管理与遥测（9） | `tool-plugin-manager`、`plugin-manager`、`hmr`、`config-editor`、`settings`、`session-log-deepseek`、`plugin-package-inventory-deepseek`、`otel`、`session-telemetry-otel` | 遥测、插件清单上报和面向模型的插件管理按现有隔离策略关闭。配置编辑器与管理后台等服务按依赖验证后再调整。 |

原版 SDK 的禁用与平台条件如下。未列出的配置项也可能等待依赖或只在某条业务路径上工作。

- `hmr`、`session-title-llm`、`fs-observation-policy` 和 `tool-executor-ptc` 默认禁用。原版 SDK 显式启用了模型可见的 `tool-plugin-manager`。
- `bash-sandbox` 与 `tool-bash` 在 Windows 禁用，`pwsh-sandbox` 与 `tool-pwsh` 在非 Windows 禁用。
- `plugin-manager`、`config-editor` 和 `settings` 依赖有效的 profile 上下文。缺少 `DSH_PRIMARY_RUNTIME` 时，`workspace-dependencies` 禁用。 [基础 bundle](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/packages/bundle/base/cordis.patch.yml) · [SDK bundle](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/packages/bundle/sdk-app/cordis.patch.yml)

## DiAgent 当前的实际覆盖

| 入口 | 配置装配与模型可见性 |
| --- | --- |
| 共用执行 | 每轮用临时 DSH home 启动 `sdk`，传入 DiAgent 补丁与 `diagent-model`，完成后关闭进程并清理 home。历史是否进入新一轮取决于请求携带的消息。 [执行入口](../../src/dsh/task-runtime.ts) |
| 一次性 Task | 显式禁用日志上报、遥测、插件清单上报、插件管理工具、Web、日程、人工询问、目标工具与工作区指令读取。默认工具的单 Agent 任务可以加载内置 Office Skills 并激活 Office 工具。Linux 启用旧 `shell` 适配。事件默认按兼容行为启用，部署可关闭。空 Skills 名单会使用配置的 Skills 目录。MCP 按服务器配置追加，旧 `task.tools: []` 的语义是关闭 MCP。 [Task profile](../../src/dsh/profile.ts) · [Task 配置](../../src/task/config.ts) |
| Chat 与常驻 A2A | 与 Task 共用 SDK 运行入口。Chat profile 显式禁用三项上报组件，按请求追加 Shell、事件与 MCP 插件，并根据提供的历史、SSE 请求加入相应适配。工具限制在 Agent 创建时应用，已挂载的 DSH 内部组件可以继续服务于授权工具。普通 Chat 的空工具列表经过回归验证。 [Chat 装配](../../src/service/chat.ts) · [工具限制](../../src/dsh/plugins/tool-selection.ts) · [Chat 回归](../../tests/dsh-service.test.mjs) |

对真实 Linux `writeTaskProfile` 生成的补丁做合成验证，示例设为无 MCP、五轮工具预算、启用事件。DSH 的 `--dump-config` 从 115 得到 **119 条**，增加 `diagent-publish-event`、`diagent-legacy-shell`、`diagent-task-temperature` 与 `diagent-tool-round-limit`。11 条原有配置变成 `disabled: true`。该验证观察配置合成结果。 [Task profile](../../src/dsh/profile.ts)

两个兼容约束需要先保留。旧 `shell` 通过 DSH 工具执行管道内部调用 `bash`，隐藏模型可见的原生 Bash 不等于可以撤掉 Bash 执行链。DiOS Chat 目前会在 Agent 配置 Skills 时一并选择 Shell 和事件工具，开始独立配置这些能力时需要兼容现有选择规则。 [旧 Shell 实现](../../src/dsh/plugins/legacy-shell.ts) · [DiOS Chat 请求装配](https://github.com/Zewang0217/DiOS/blob/8d645e7a0111a94973684a0ba80389e0357a937c/backend/app/api/apps/chat.py#L144)

## 调整优先级

1. **保留 DSH 基础。** 继续验证模型路由、Session、原生工具执行、权限、取消、上下文压缩和错误回传。会话 JSONL 是 DSH 的执行记录。DiOS 可独立决定传入哪些历史。
2. **先明确每次运行的业务能力。** 优先收口 Shell、文件访问、Skills、MCP、事件和 Web。先在两个入口测试空工具列表与精确授权，再按启动配置检查哪些工具插件确实无需加载。保留当前 Task 缺省行为或提供兼容映射。
3. **按能力组精简可选模块。** 先验证 Office、日程、目标、子 Agent、工具工作流、文件交付界面、原生 DeepSeek 账号和配置管理的实际调用。完成相关兼容测试后，再按组关闭。单次只有纯文本交互时，关注可见工具与插件启动分别有何差异。
4. **如需更轻的启动，单独评估 `sdk-minimal`。** 同一版本已提供此 profile。它仍含平台 Shell、读图、会话 JSONL，沙箱策略默认更宽，且它的独立 bundle 没有本项目当前使用的 `llm-pi-ai` 配置行。要重建模型路由、权限策略和能力回归后再考虑切换。 [固定版本的 `sdk-minimal` bundle](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.2-rc.3/packages/bundle/sdk-minimal/cordis.patch.yml)

## 运行成本实测

在同一张 Linux amd64 service 验收镜像、同一容器内用 `runDshTurn` 串行运行 12 组配对。对照组沿用当前纯文本 Chat 的装配。精简组用同一 profile 再禁用 25 个可选配置项，覆盖 Office、Web、调度、文件工具、Shell 工具和子 Agent 等。两组均使用空工具白名单和同样的本机模拟模型，每次启动新 DSH 子进程、发送一次纯文本请求并核对结果。预热每组各一次，随后交替运行顺序。内存以 20 毫秒间隔采样子进程树 RSS。以下为中位数。

| 指标 | 当前装配 | 关闭 25 项 |
| --- | ---: | ---: |
| 启动到模拟模型收到首个请求 | 3.100 秒 | 2.928 秒 |
| 单轮完成与进程收尾 | 3.235 秒 | 3.052 秒 |
| DSH 子进程树峰值 RSS | 384.2 MiB | 352.6 MiB |
| 模型请求的 `messages` JSON | 3,814 字节 | 2,419 字节 |

这里测到的是无工具短请求。未测真实供应商推理时间、工具型任务或并发容量。消息体字节可反映上下文大小，真实 token 量取决于模型。

两组使用相同镜像，镜像大小差为 0。Task 和 service 验收镜像的文件系统层逐一相同，Docker 分别报告 364,872,421 和 364,872,594 字节。容器内 `node_modules` 的 `du` 显示约 1.21 GiB。25 项对应的 24 个直接插件包目录合计约 48.8 MiB。部分依赖共用，只统计这些目录无法得出重建净节省。Office 的可选传递依赖 `libreoffice-kit-wasm` 单独占 145.5 MiB，单包 tar+gzip 约 44.9 MiB。该包是后续瘦身的候选，需重建镜像验证兼容性和实际差值。 [依赖锁文件](../../package-lock.json) · [Docker 镜像层](https://docs.docker.com/engine/storage/drivers/)

默认部署沿用现有装配。精简启动对短请求有一定收益，高并发或短请求占主导时可单独评估。若目标是降低分发体积，优先验证 Office 依赖的可选打包方案。
