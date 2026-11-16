# AI4R Reviewer 切换与回滚验收

供目标环境操作者验收 TypeScript + DSH 两张镜像。先确认试点覆盖的任务，再分别切换一次性任务与常驻服务。已有本地结果见 [v0.1 待办](TODO.md)。

## 发布 task 和 service 镜像

`Build DSH images` 工作流在同一次运行中构建和测试 Linux amd64 的 `task` 与 `service` 两张镜像。工作流进入默认分支后，由仓库操作者在 Actions 选择包含已验收改动的源码版本，手动运行工作流并启用 `publish`。记录运行的完整 SHA，并从同一次成功运行的摘要中抄录 `agent-task`、`agent-service` 各自的仓库 digest。工作流按执行它的仓库发布 `dsh-<完整 Git SHA>` 标签。原有 `Build Docker Image` 工作流仍从 Python Dockerfile 生成 `latest`。为回滚分别记录当前 task、service 的完整镜像引用和实际镜像 ID。

验收主机按 digest 拉取镜像。通过部署的 Compose 环境配置，把任务镜像完整引用交给 `DIOS_DIAGENT_IMAGE`，把常驻镜像完整引用交给 `DIOS_DIAGENT_SERVICE_IMAGE`。两者可以分别切换。先按本文完成任务镜像验收。常驻镜像在功能兼容项完成后切换，切换时需要把复用中的旧常驻 Agent 容器重新创建。

使用独立任务 API 的部署，在同一待发布提交上运行 `npm run test:task-api`。现有镜像工作流覆盖容器内的一次性任务、事件插件和常驻服务，宿主机独立 API 的测试单独运行。

## 核对存量配置

本机 DiOS 的 SQLite 没有登记 Agent。旧 DiAgent 仓库的 `workspace/agent-task.json` 示例配置了具名子 Agent。目标环境需要清点实际调用，确定哪些适用已验收的 DSH `once` 路径。

在试点主机按部署方式把 DiOS API 地址填入 `DIOS_PILOT_URL`，沿用已配置的访问令牌。以下 Bash 命令只读查询 task 模式的 Agent，输出总数及配置了具名子 Agent 或自定义 middleware 的 Agent ID。命令不打印完整响应。

```bash
(
  set -o pipefail
  printf 'Authorization: Bearer %s\n' "${DIOS_ACCESS_TOKEN:-}" |
    curl --fail --silent --show-error --header @- "${DIOS_PILOT_URL%/}/api/os/agents?mode=task" |
    python3 -c '
import json
import sys

agents = json.load(sys.stdin)
if not isinstance(agents, list):
    sys.exit("Expected a DiOS Agent list")
print("task_agents=" + str(len(agents)))
for agent in agents:
    capabilities = agent.get("capabilities") or {}
    checks = []
    if capabilities.get("subagents"):
        checks.append("subagents")
    if (capabilities.get("reasoning") or {}).get("middleware") is not None:
        checks.append("reasoning.middleware")
    if checks:
        print(agent["id"], ", ".join(checks))
'
)
```

另从调用方核对直接运行旧镜像的任务配置。包含具名 `subagents`、`middleware_config`、`thread_id` 或执行器内 `schedule/interval` 的任务需要单独迁移。周期任务可由现有调度器定时派发一次性任务，仍需核对触发间隔与重复执行行为。若同一 DiOS backend 调度了暂未迁移的任务，为试点使用独立 backend 和测试订阅。

## 准备固定版本的候选镜像

下面用已验证的参考提交 `d9984e4e0f2a2d1bbd7b5435613040e9522c0177` 演示手动构建 `task`，供本地演练。Docker 基础镜像和系统包可能随时间变化，正式验收使用发布工作流记录的 digest。以下以 Linux x86_64 为例，先确认验收主机的 Docker 架构。

```bash
revision=d9984e4e0f2a2d1bbd7b5435613040e9522c0177
candidate_ref=dios-diagent-task:dsh-d9984e4
git archive --format=tar "$revision" |
  docker build --platform linux/amd64 --target task \
    -f docker/agent-task-dsh/Dockerfile \
    --label "org.opencontainers.image.revision=$revision" \
    -t "$candidate_ref" -
docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_ref"
docker run --rm --pull never --entrypoint node "$candidate_ref" --version
```

若镜像在别的 daemon 上构建，使用目标环境的镜像仓库传递。镜像仓库地址填写到镜像名为止，包含组织路径。使用该仓库已有的鉴权方式。

```bash
registry_image='registry.example.com/team/diagent-task'
docker tag "$candidate_ref" "$registry_image:dsh-d9984e4" &&
  docker push "$registry_image:dsh-d9984e4"
```

记下 push 返回的仓库 digest。在验收主机加载该 digest 对应的镜像并核对架构与修订标签。

```bash
published_ref='registry.example.com/team/diagent-task@sha256:填写推送返回的digest'
docker pull "$published_ref" &&
  docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$published_ref" &&
  docker run --rm --pull never --entrypoint node "$published_ref" --version
```

目标环境最终切换使用此次验收的 digest。仓库 digest 用来定位发布产物，容器实际镜像用本地镜像 ID 核对。

`node --version` 只验证容器能启动。候选镜像仍需跑一条完整的 Reviewer 任务，覆盖 DSH 原生模块加载。若部署覆写 `TMPDIR`，核对其挂载选项。已复现 `noexec` 的临时目录会导致 DSH 原生绑定无法加载。

## 切换前核对

- 使用目标环境的验收实例，沿用目标环境的 DiOS 版本、Docker 网络、工作区挂载和鉴权方式。验收实例只启用测试 Reviewer 的相关订阅。现有 AI4R 场景里 Writer 也订阅 `ai4r.review.completed`，收到 `changes_requested` 后会再提交草稿。直接在共享实例触发测试事件可能启动后续任务。
- `DIOS_DIAGENT_IMAGE` 是单个 DiOS backend 的全局配置。该实例通过它创建所有新的一次性任务容器。先核实实际生效的 Compose 项目与配置文件，确保操作指向验收实例。常驻 Agent 使用 `DIOS_DIAGENT_SERVICE_IMAGE`。
- 从任务容器所在网络确认 `DIOS_API` 可访问。启用全局令牌的 DiOS 使用 `DIOS_DIAGENT_EVENT_GRANTS` 为试点 Agent 登记限权事件凭据，给 Agent 注入对应的 `DIAGENT_EVENT_ACCESS_TOKEN`。核对授权来源、事件类型和匹配的订阅，先验证一次获准发布和一次越权拒绝。凭据通过目标环境现有的密钥配置注入。

## 记录镜像和运行状态

在验收主机上使用实际部署的 Compose 入口。如果部署用多个 `-f`、`-p` 或 `--env-file` 参数，下文每次 `docker compose` 都沿用同样的参数。候选镜像需先由操作者加载到 DiOS 所连接的 Docker daemon。

```bash
backend_id=$(docker compose ps -q backend)
task_ref=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$backend_id" |
  sed -n 's/^DIOS_DIAGENT_IMAGE=//p')
test -n "$task_ref" && printf 'task image ref: %s\n' "$task_ref"
docker info --format 'daemon={{.Name}}'
docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$task_ref"
docker ps --filter label=dios.run_id --format '{{.Names}} {{.Image}} {{.Status}}'
```

另查 `GET /api/os/a2a/tasks?status=working` 确认业务在途状态。`docker ps` 的标签筛选覆盖同一个 daemon 上多个 DiOS 实例，用任务 ID 对照验收实例。先用旧镜像跑一条基线任务，记录任务实际镜像 ID、终态、产物和完成事件。用候选镜像的本地引用执行 `docker image inspect`，记录候选 ID。两者应不同。

## 切换后验收

如果验收实例使用可写的本地镜像标签，可在同一 daemon 上更换标签指向。DiOS 每次创建一次性任务容器时都读取该引用，backend 无需重启。先确认该标签只供本次验收使用，再填入上一节记录的两个镜像 ID。标签改动只发生在当前 daemon。

```bash
old_id=$(docker image inspect --format '{{.Id}}' "$task_ref")
candidate_id='sha256:填写候选镜像ID'
docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$old_id" "$candidate_id"
docker image tag "$old_id" "diagent-reviewer-rollback:$(date -u +%Y%m%d%H%M%S)"
docker image tag "$candidate_id" "$task_ref"
docker image inspect --format '{{.Id}}' "$task_ref"
```

若 `task_ref` 固定为 digest，或标签有其他部署共用，按原部署方式改验收实例的 `DIOS_DIAGENT_IMAGE`，并仅重建 `backend`。沿用原数据库卷、工作区、Docker 网络和 Compose 项目。`docker compose up -d --no-deps --force-recreate backend` 后先查 `/health`，再核对 Agent、订阅和原任务记录。若当前 backend 未含 DiOS 的容器轮询恢复修复，等在途任务收尾后再重建。

旧镜像、DSH 和回滚三阶段各准备一个独立测试项目及合成草稿，使用 Reviewer 工作区预期的 `projects/<project_id>/manuscript/draft.md`。通过 `POST /api/os/events/manual` 或网页登记 `ai4r.draft.submitted`。来源用验收订阅允许的 `ai4r/...` 值，主题和 `data.project_id` 使用当轮项目标识。若订阅匹配固定来源，三阶段使用同一授权来源和各自独立的项目标识，保留部署的去重策略。

1. 记录返回的 `event_id`，确认 `matched_agents` 只含测试 Reviewer。查 `GET /api/os/events/<event_id>/activity-overview` 获取任务 ID。
2. 任务运行中，用 `docker inspect --format '{{.Image}} {{.Config.Image}}' "dios-run-${task_id:0:12}"` 记录实际镜像。用镜像 ID 与候选值对比，因为标签可复用。运行时间很短时，边提交边观察容器创建记录，DiOS 会在回收结果后移除容器。
3. 查 `GET /api/os/a2a/tasks/<task_id>`，确认 `completed` 并登记 `task_result.md`。在该项目工作区确认本轮生成 `review.md`。按项目标识和时间核对 `GET /api/os/events?event_type=ai4r.review.completed` 中只有一条对应完成事件。完成事件可显示零匹配。
4. 有条件时在切换前发一个独立的旧镜像任务，等容器进入运行状态后换标签，再看旧任务是否继续完成、新任务是否采用候选镜像。把容器实际镜像 ID 和两条任务记录一同保存。

## 回滚

等候选任务收尾。标签切换路径使用 `docker image tag "$old_id" "$task_ref"` 恢复引用，并核对返回的镜像 ID。Compose 路径恢复旧镜像引用，按相同部署方式重建验收 backend。用第三个项目重复上述验收，确认实际使用旧镜像，并保留数据库中的前两轮记录。将三个阶段的事件 ID、任务 ID、实际镜像 ID、产物和完成事件登记到 [v0.1 待办](TODO.md)。

## 常驻服务切换与回滚

`DIOS_DIAGENT_SERVICE_IMAGE` 和 `DIOS_DIAGENT_SERVICE_MODEL_PROXY` 都作用于整个 backend。仅试点个别 Agent 时，使用独立验收 backend；同一 backend 中仍在兼容模式运行的常驻容器会阻止切换推理模式后的请求，直到旧容器停止。

1. 记录当前 service 镜像、`DIOS_DIAGENT_SERVICE_MODEL_PROXY` 的值和一个已有 Chat 会话。仅对试点 Agent 暂停新请求，待当前 Chat 和 A2A 收尾。核对容器的 `dios.agent_id` 标签与 Agent ID 后停止其旧常驻容器。
2. 启用受管推理前，为试点 Agent 核对独立工作区。将旧 `models.yaml`、`mcp_servers.json` 和 `agent-task-*.json` 移出所有供 Agent 读取的挂载。核对模型与 MCP 上游凭据已保存在 DiOS，试点 Agent 已分配对应模型、MCP 和 Skills。
3. 按部署方式设置 `DIOS_DIAGENT_SERVICE_IMAGE` 和 `DIOS_DIAGENT_SERVICE_MODEL_PROXY=true`，保持 `DIOS_ACCESS_TOKEN` 已配置。重建验收 backend，确认健康后用已有会话发送一轮 Chat，使 DiOS 创建新常驻容器。核对实际镜像 ID、旧历史、SSE 结束帧、一次获准工具调用及一次常驻 A2A 的产物。核对上游密钥和旧配置文件未出现在容器环境或工作区。
4. 回滚前先让请求收尾，再停止该试点容器。恢复记录的旧镜像引用和原有推理模式，重建验收 backend。旧 Python 镜像使用兼容模式时，让 DiOS 按原部署配置生成模型目录。用同一 Agent 复验 Chat、A2A 和既有会话记录。

本地以模拟模型在兼容模式演练了常驻镜像切换与回滚，也单独验证了受管推理和真实 `ecnu-max` SSE。目标环境应记录实际切换前后的推理模式和容器镜像。
