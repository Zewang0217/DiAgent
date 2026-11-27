# DiAgent Task 协议

本文是 Task 容器与调度器之间的稳定契约。调度器负责身份、授权、业务并发和产物交付；DiAgent 负责一次运行如何启动、调用模型、暴露工具和报告终态。

对应的机器可读定义：

- `schema/task-config.schema.json`
- `schema/task-result.schema.json`
- `schema/task-events.schema.json`

协议测试：

```bash
npm run build
node --test tests/task-protocol-schema.test.mjs
```

## 输入

调度器把任务配置挂载为 `TASK_CONFIG`。模型和外部服务凭据不进入任务文件。

```json
{
  "models": {
    "default_model": "office",
    "models": {
      "office": {
        "provider": "openai",
        "model": "ecnu-max",
        "base_url": "http://127.0.0.1:8765/v1",
        "api_key": "temporary-task-grant",
        "input_modalities": ["text", "image"]
      }
    }
  },
  "task": {
    "task": "生成一份 Word 报告",
    "system_prompt": "你是文档助手。",
    "workspace": "/workspace",
    "skills_dir": "/skills",
    "skill_names": ["docx"],
    "tool_selection": { "tool_ids": ["skill", "shell"] },
    "recursion_limit": 10000,
    "output": { "result_file": "task_result.md", "log_file": "task.log" }
  }
}
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `task.task` | 已批准的任务文本，必填 |
| `task.system_prompt` | 本次运行的角色提示 |
| `task.workspace` | 容器内工作区，默认 `workspace` |
| `task.skills_dir` / `skill_names` | 内置技能目录与显式选择 |
| `task.extra_skill_roots` | 宿主冻结的自定义技能根，需 `DIAGENT_TASK_CUSTOM_SKILLS=true` 和 `skill` 授权 |
| `task.tool_selection.tool_ids` | 本次运行显式可见的工具 |
| `task.host_tools` | 宿主提供的具名工具描述，需 `DIAGENT_TASK_HOST_TOOL_BRIDGE=true` |
| `task.subagents` | 具名子 Agent；不能与宿主工具同时启用 |
| `task.output` | 运行目录内的结果文件和日志文件名 |
| `task.trigger.mode` | 当前只支持 `once` |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TASK_CONFIG` | 任务配置路径，必填 |
| `OUTPUT_DIR` | 输出根目录覆盖 |
| `DIAGENT_TASK_PROTOCOL_DIR` | 写入 `events.ndjson`、`result.json` 和检查点的控制目录 |
| `DIAGENT_TASK_TIMEOUT_MS` | 整段执行时限；默认 30 分钟 |
| `DIAGENT_TASK_MODEL_SOCKET` | 宿主受管模型的 Unix socket；设置后可不提供 refresh 文件 |
| `DIAGENT_TASK_MODEL_REFRESH_PATH` | 可选的模型刷新凭据文件；需与受管模型入口一起使用 |
| `DIAGENT_TASK_HOST_TOOL_BRIDGE` | `true` 时允许 `task.host_tools` |
| `DIAGENT_TASK_CUSTOM_SKILLS` | `true` 时允许 `task.extra_skill_roots` |
| `DIAGENT_TASK_PAUSE_ON_LIMIT` | `true` 时步数耗尽返回 `paused` |
| `DIAGENT_TASK_RESUME_SESSION` | 续跑时复用原 DSH 会话 UUID |
| `DIAGENT_ENABLE_DIOS_EVENTS` | 是否启用 DiOS 事件发布，Task 默认关闭 |

`DIAGENT_TASK_MODEL_SOCKET` 与 `DIAGENT_TASK_MODEL_REFRESH_PATH` 至少设置一个，才能启用 `shell`、文件工具、Office 和宿主工具。只有 refresh 时沿用 HTTP 模型桥；只有 socket 时由 DiAgent 父进程以 root 转发到 broker 子进程。

## 模型入口

受管模型入口对 broker 暴露 OpenAI 兼容 HTTP：

- `POST /v1/chat/completions`
- `POST /tools/call`（仅宿主工具启用时）
- 可选：`POST /v1/grants/refresh`

请求使用任务授权 `Bearer <task-grant>`；供应商凭据只存在于宿主的模型代理。Unix socket 与 HTTP 上游使用相同路径语义。

## 输出

### `result.json`

成功、暂停、失败都走同一文件。version 2：

```json
{
  "version": 2,
  "status": "failed",
  "summary": "",
  "error_code": "step_limit",
  "error": "step_limit",
  "artifacts": [],
  "steps": 42
}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `completed` / `paused` / `failed` |
| `error_code` | 稳定失败码；完成和暂停时省略 |
| `error` | `error_code` 的 v1 兼容副本 |
| `artifacts` | `output/run-task` 下的工作区相对路径 |
| `steps` | 本段执行的模型步数 |
| `checkpoint_ref` | 暂停时可恢复的 DSH 会话 UUID |

已知失败码：

| 代码 | 含义 |
| --- | --- |
| `step_limit` | 达到任务步数上限 |
| `timeout` | 整段执行超时 |
| `interrupted` | 收到 SIGINT/SIGTERM |
| `invalid_config` | 任务配置无效 |
| `engine_error` | DSH 执行失败 |

配置在 `TaskResultProtocol` 建立前失败时，DiAgent 仍会向 `DIAGENT_TASK_PROTOCOL_DIR/result.json` 写入 `invalid_config`。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | completed 或 paused |
| `1` | 执行失败 |
| `2` | 配置错误 |

`result.json` 的 `error_code` 优先于退出码；退出码只用于没有结果文件的兜底。

### `events.ndjson`

每行一个 version 1 事件：

```json
{"version":1,"seq":1,"at":1710000000000,"type":"started"}
{"version":1,"seq":2,"at":1710000000001,"type":"step_started","steps":1}
{"version":1,"seq":3,"at":1710000000002,"type":"tool_started","tool":"shell","call_id":"call-1"}
{"version":1,"seq":4,"at":1710000000003,"type":"tool_finished","success":true,"call_id":"call-1"}
{"version":1,"seq":5,"at":1710000000004,"type":"finished","status":"failed","error":"step_limit"}
```

`seq` 在单个控制目录内单调递增。原始命令、参数、路径和凭据不会写入事件。

## 宿主工具

请求：

```json
{
  "call_id": "native-call-id",
  "tool": "image_generator",
  "arguments": { "prompt": "校园插画" }
}
```

响应：

```json
{ "result": "generated.png" }
```

失败响应使用 `{ "error_code": "tool_failed" }` 和对应 HTTP 状态。`call_id` 由 DSH 原生工具调用产生；宿主用它与参数指纹去重，不自动重放未知副作用。

## 检查点与续跑

`DIAGENT_TASK_PAUSE_ON_LIMIT=true` 时，达到步数上限返回 `paused` 和 `checkpoint_ref`。调度器必须保留同一控制目录和工作区，下一段使用原镜像、原模型和 `DIAGENT_TASK_RESUME_SESSION` 启动。已完成的外部工具调用由宿主账本恢复，不能被模型重放。

## 兼容性

- 只读 v1 结果的旧调度器仍可通过 `error` 读取失败码。
- 没有 `model-socket` 能力的旧镜像继续由宿主注入 `run.mjs` 和 `model-refresh.json`。
- 新镜像通过 `org.hqit.diagent.model-socket=1` 声明 socket 能力。
- 工作区工具、Office 和宿主工具要求受管模型入口（socket 或 refresh），不再单独依赖 refresh 文件。
