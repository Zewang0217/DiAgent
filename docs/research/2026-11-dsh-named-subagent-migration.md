# DSH 具名子 Agent 迁移验证

本文记录旧版 `task.subagents` 的行为和 DSH `0.2.2-rc.3` 的本地验证结果，用于确定一次性任务的兼容实现与验收范围。

## 旧版调用契约

主 Agent 按名称和描述委托子 Agent。旧 DiAgent 为每个子 Agent 构造角色提示、可选模型与 MCP 配置、工具名单和 Skills，并在角色提示中加入本次任务的产物目录。旧版还会把可选的 `task` 字段传给 deepagents，该字段对实际委托的效果待用旧镜像对照。DiOS 已能把 Agent 的 `capabilities.subagents` 写入一次性任务配置。

仓库独立任务样例有 `researcher`、`writer`、`reviewer` 三个角色，三者均显式引用模型。前两个配置了各自的 MCP 路径，后两个配置了专门的 Skills。样例中的空子 Agent 工具名单会让旧执行器取相应注册表的全部工具。有独立 MCP 配置时使用那个注册表，否则使用主任务注册表。迁移时需结合实际获准的工具解析这个空名单。当前本机 DiOS 没有登记 Agent 或订阅，目标环境是否有存量调用仍待确认。

## 固定版本验证

在离线 Linux 镜像 `diagent-task:agent-tools-refresh-local` 中，用实际 `runDshTurn` 和本容器的模拟 OpenAI 端点运行。探针在 `sdk` 基础配置插入 DSH preset 注册表、默认 preset、reviewer preset 和指向它的 `delegate_reviewer` 工具。角色通过 preset 内的 `dsh-persona` 插件配置。

| 验证 | 观测 |
| --- | --- |
| 按角色委托 | 主 Agent 调用 `delegate_reviewer` 得到 `started subagent reviewer`。角色标记只出现在子 Agent 的系统消息中。 |
| 子结果交付 | 模拟子模型延迟 1.8 秒返回。主 Agent 显式调用 `wait_agent` 时收到了完成通知。主模型先返回结束文本时，在同一设置下也恢复了一步并收到子结果，执行器最终返回复核后的主回答。 |
| 工具范围 | 单独加入 reviewer preset 后，模拟子模型仍收到宿主的 `bash`、`write` 和通用委托工具等声明。角色 preset 需要配合工具授权使用。当前 DiAgent 的 `tool-selection` 在所有新 Agent 上应用同一份名单，还需要按角色区分。 |

一次性任务入口现已接入具名委托。锁定版 Linux 回归验证，主 Agent 可以委托同模型的 reviewer，父子工具名单独立生效。只读 reviewer 的写入被拒绝，获准写入的 reviewer 在本次运行目录生成报告，且主 Agent 收到子结果。测试也覆盖了省略父工具名单及无工具的 reviewer。配置格式见 [一次性任务入口](../../README.md#typescript--dsh-一次性任务试点)。

## 迁移设计与验收顺序

1. DiAgent 根据任务的 `subagents` 配置，为主 Agent 提供对应的具名委托入口。DSH 的 `spawn` 启动独立会话，子 Agent 收到自己的角色提示和工具名单。原生文件工具使用 `tool_selection.tool_ids` 显式声明。旧的 `subagents[].tools` 可引用同名 MCP 工具，收到旧字段时执行器会给出迁移提示。
2. DiOS 已能通过 A2A 下发同模型角色及独立 Skills、MCP、文件工具配置。隔离 Docker 任务 `5c84c0a3f0f4402796a846620afd086a` 中，`alpha` 和 `beta` 从同一个 MCP 服务分别取得不同结果。模拟模型尝试调用对方的工具，上游只收到两次获准调用。主 Agent 把两份结果传给 reviewer，后者加载专属 Skill 并生成 `reviewer-report.md`。DiOS 的任务产物回收覆盖主结果和同一运行目录里的 Markdown 报告，可从 A2A 或 Console 查阅。
3. 用模拟模型在任务 `d40c62eca632496a8ef8114f5411c433` 中拒绝子角色推理。DSH 重试后将失败通知发给主 Agent，主 Agent 返回失败说明并结束任务。两次任务下发的角色 MCP 授权均被撤销。并发子任务、预算耗尽、取消和有状态 MCP 上游会话待补验收。

当前版本中，子 Agent 沿用任务已经选择的模型。按子 Agent 单独选择模型和签发模型授权留待有具体需求时再讨论。

以上委托发生在一次 DiAgent 任务内部。DiOS 仍负责调度独立任务，多个独立 DiOS Agent 共用容器继续列为后续方向。
