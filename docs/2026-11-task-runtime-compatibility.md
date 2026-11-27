# Task 运行时兼容性说明（2026-11）

本文给其他以 DiAgent 为底座的调度器/镜像项目看，说明本轮 Task 运行时改动的兼容边界。

## 当前状态

- 镜像只在本地构建，尚未推送任何 registry。
- 当前 ChatECNU 网关未上生产；本文不涉及线上部署。
- 通用 `task` 构建目标未改变；原生 Office 使用新增的 `office-task` 目标。

本地验证镜像：

```text
diagent-office-runtime:verify-t5
chatecnu/diagent-office:verify-t5
```

## 改动与兼容性

| 改动 | 对其他项目的影响 | 需要做什么 |
| --- | --- | --- |
| 新增受管模型 Unix socket | 纯增量。原有 HTTP `base_url` + `DIAGENT_TASK_MODEL_REFRESH_PATH` 路径保留 | 不需要改动；想用 socket 时设置 `DIAGENT_TASK_MODEL_SOCKET` |
| 受管模型与 refresh 解耦 | `shell`、文件、Office、宿主工具改为按“socket 或 refresh”判断 | 原来只传 refresh 的调用方式不变；不再需要伪造 refresh 文件 |
| `result.json` v2 | 新增 `error_code`，保留 v1 `error` 字段；退出码仍为 0/1/2 | 新代码优先读 `error_code ?? error`；旧代码继续读 `error` 即可 |
| 配置失败也写 `result.json` | 调度器能拿到 `invalid_config`，不再只能看 stderr/退出码 | 建议先读结果文件，再回退退出码 |
| 通用 skill 事件 | `skill` 名从参数解析，不再写死 `office-*` | 使用 `skill` 字段的消费方无需改；可收到任意合法 skill 名 |
| 递归产物清单 | `artifacts` 可包含 `output/run-task` 子目录文件 | 按相对路径处理，不要假设只有一层 |
| `office-task` 构建目标 | 通用 `task` 目标不变；只影响构建原生 Office 任务镜像的项目 | 改用 `target: office-task`；删除项目内复制的 `prune-dsh-office.mjs` |
| Task schema/协议文档 | 纯文档和测试，不改变运行时行为 | 可参考 `docs/task-protocol.md` 和 `schema/*.json` |

## 对其他 DiAgent 项目的最小检查清单

1. 仍使用 `TASK_CONFIG` 和 `DIAGENT_TASK_MODEL_REFRESH_PATH`：不需要改。
2. 解析 `result.json`：允许 `version: 1|2`，优先 `error_code`。
3. 构建原生 Office 任务镜像：使用 `office-task` 目标，不要在产品仓库里直接改 `node_modules`。
4. 自定义镜像标签：声明 `org.hqit.diagent.model-socket=1` 才会走新 UDS 路径；未声明时继续旧入口。
5. 自定义技能：继续走 `DIAGENT_TASK_CUSTOM_SKILLS=true` + `task.extra_skill_roots`，无变化。

## 回滚

- 运行时回滚点：`3440411`（schema/事件改动前）或 `b761f8e`（本轮改动前）。
- 镜像回滚点：保留切换前本地镜像 tag 即可；本轮没有推送远端。
- 网关侧回滚：父仓库子模块指回旧 commit，并保留旧 `run.mjs + model-refresh.json` 兼容分支。

## 不在本文范围

- 生产镜像推送、registry 配置、网关重启。
- ChatECNU 的 OSS、Redis 续跑、SSE 和任务中心字段。
- 其他项目的业务提示词、交付格式和部署拓扑。
