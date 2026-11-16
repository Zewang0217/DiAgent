# DiAgent v0.1 待办

按 [兼容基线](2026-11-diagent-v0.1-compatibility-baseline.md) 跟踪实现、测试、评审和部署验证。依赖同一入口的功能按顺序推进，每项验收证据在完成后补齐。

v0.1 的交付目标是用 TypeScript + DSH 完整替代现有 DiAgent。一次性任务和在线服务统一使用 DSH，旧镜像仅用于切换验证与回滚。

## 镜像交付

- [x] 从 `d9984e4` 生成同版本 Linux amd64 task、service 参考镜像。task 回归 11 项通过。`dios-diagent-service:dsh-d9984e4` 镜像 ID 为 `sha256:1791677fceef96ac1b3deabd88e7db02da0ea5ee0360b75b7eaf6f2427186a20`，服务回归 3 项通过。
- [x] 确定发布候选的锁定依赖。DSH 统一升级至 `0.2.2-rc.3`，YAML 升级至 `2.9.1`。DSH 仍固定旧的 `undici`、`fflate` 和 MCP client，临时覆写到 `8.12.2`、`0.8.3` 和 `2.3.0`。npm 生产依赖审计由 211 项降到 0 项，Linux task 11 项和 service 3 项回归通过。后续 DSH 若采用已修复版本，移除对应覆写并复验。
- [x] 新增 DSH 双镜像发布工作流。同一源码修订构建并测试两张镜像，手动发布使用完整提交 SHA，双镜像推送成功后记录两个仓库 digest。DiOS 三种部署 Compose 均验证了独立 digest 覆写及旧默认值。
- [x] 最终候选两张镜像在隔离 DiOS 联调通过。Reviewer 同标签切换与回滚的三次任务为 `25656792552a`、`7c87a9eaf282`、`29225b0083a6`。常驻服务复用同一容器完成两次单轮请求，并将模拟模型错误登记为 `failed`。工作流已离线验证两次推送成功和第二次推送失败的摘要行为。
- [ ] 在 GitHub Actions 运行发布工作流并登记两个仓库 digest。工作流需由仓库操作者执行。
- [ ] 让目标环境分别按 digest 选择 task 和 service，走现有 [Reviewer 切换与回滚验收](2026-11-reviewer-cutover.md)，并验证常驻容器实际使用的镜像和回滚。两类镜像可独立切换，常驻服务切换还需满足下方兼容项。

## 当前 ticket

- [x] DiAgent 本地 Compose 和 DiOS 开发配置统一使用 DSH 的 `task`、`service` 构建目标。两个入口均成功构建镜像，DiOS 的镜像标签和容器网络与 Compose 展开结果一致。两路评审后修复了默认任务样例和网络配置。默认样例在容器内通过解析，Linux 镜像中任务 11 项、服务 3 项测试通过。Windows 原生单轮服务测试返回 502，待单独定位。目标环境切换继续按下方验收项执行。
- [x] 支持 DiOS 下发的 `max_tool_rounds`。Windows 与 Linux 集成测试各 11 项通过，真实 DSH 对同一步的两次 MCP 调用只扣一个轮次，下一步超额调用未到达模拟工具。双评审通过。使用 AI4R Reviewer 配置脚本中的 `recursion_limit=120`、`max_tool_rounds=20`，本机 DiOS 调度 Linux 镜像成功回收模拟任务 `acc24a8df62d` 的产物。
- [x] 完成本地 AI4R Reviewer `once` 新旧镜像对照。用同一份合成草稿、仓库 Reviewer 提示词和 `ecnu-max` 顺序运行两次。旧 Python 和新 DSH 均退出 0、写出 `review.md` 和 `task_result.md`，并各在隔离 DiOS 登记一条 `ai4r.review.completed`。两份报告均指出缺少样本量、基线定义不清，最终答复均为 `changes_requested`。另用模拟模型完成五项对照，模型返回 HTTP 400 时两版均退出 1 且无新事件，重新选用旧镜像后成功。
- [x] 在本机 DiOS 用同一条 Reviewer 订阅演练一次性任务镜像切换。三轮依次为 Python `cd9c1fc296d3`、DSH `3614ed9c68b5`、回滚 Python `c7846ca71f1f`。每轮通过事件 API 提交 `ai4r.draft.submitted`，核对实际容器镜像、A2A 终态、`review.md`、DiOS 登记的 `task_result.md` 和一条 `ai4r.review.completed`。等任务完成后才重新创建 DiOS `backend` 容器，复用同一 SQLite 和工作区，Agent、订阅和已完成任务跨重启保留。演练使用模拟模型和源码重建的旧镜像。
- [ ] 在目标环境复验切换与回滚。按 [Reviewer 切换与回滚验收](2026-11-reviewer-cutover.md) 核对镜像、现有订阅和发布鉴权，分别记录旧镜像、DSH 和回滚三阶段的结果。操作步骤已整理，目标环境执行待完成。
- [x] 2026-11-16 从 Git 提交 `d9984e4` 无缓存重建 Linux amd64 验收镜像。旧本地镜像在 Docker 恢复后仍缺少文件层。重建镜像通过回归后更新 `dios-diagent-task:dsh-d9984e4`，镜像 ID 为 `sha256:ae6ee68ba74a7c30d605898d7d69d205b0e72111674e936afd315403afeee8be`。
- [x] 固定版本镜像的 Linux 一次性任务回归 11 项通过，覆盖任务输入、MCP、产物、事件发布和鉴权。诊断复现确认，测试目录若挂载为 `noexec` 并用作 `TMPDIR`，DSH 的原生绑定无法加载。去掉额外测试挂载后复验通过。
- [x] 2026-11-16 在本机隔离 DiOS 用模拟模型演练同标签切换。保持同一个 backend、数据库和 Reviewer 订阅，旧 Python 任务 `9c0c014c2e2b` 运行期间把标签指向 DSH `dsh-d9984e4`。旧容器保留原镜像并完成，新任务 `91266cc33609` 使用 DSH，恢复标签后 `75a39a889917` 使用旧镜像。按容器的实际镜像 ID 核对三轮，均完成并产生 `review.md`、`task_result.md` 和一条评审完成事件。
- [x] `publish_event` 通过本地 Linux 容器联调。DiAgent `4ec0ca3`、DiOS `f2433d9`、模拟模型、空 SQLite，无全局访问令牌。手动启动任务容器，合法事件返回 `dispatched`，非法来源被拒绝，需审批的事件返回 `approval_required`。三次运行共落库两条事件，均为合法来源，任务产物写入宿主机挂载的工作区。验收时为构建下载临时启用代理和重试，并给本地 DiOS 验收镜像补装 `sqlalchemy[asyncio]`，以满足其当前解析到的 SQLAlchemy 版本。
- [x] DiOS A2A 调度器启动 Linux 试点镜像。使用相同镜像、临时数据库及模拟模型与直连 MCP，通过 `message/send` 提交、`tasks/get` 查终态。成功用例 `f94a7feb52ea` 验证了 DiOS 生成配置、挂载共享 Skill、实际调用 Skill 和 MCP、落盘日志及登记 `task_result.md`。失败用例 `d1d5e35e5297` 模拟模型返回 HTTP 400，DiOS 登记退出码 1 和 `failed`。宿主机的 Docker Desktop 路径通过 `DIOS_HOST_WORKSPACE_ROOT` 显式映射。
- [x] 首轮直连 MCP 工具可见性已复验。早期模拟服务在处理缺少 `params` 的请求时抛错。修正响应后，延迟 `tools/list` 1.5 秒的回归在 Windows 和 Linux 均验证首个模型请求包含工具。DiOS 调度用例 `6b3fe7ab3f67` 将延迟拉到 3 秒，同样通过。双评审确认由现有 DSH 启动流程负责等待初始工具发现。
- [ ] 合入 DiOS `fix/e2ag-mcp-discovery`。DiOS `f2433d9` 在 enforce 模式下对 DSH 首发的 `server/discover` 返回 HTTP 403，模型收不到获准工具。修复在授权校验和审计后返回 JSON-RPC `-32601`，让 DSH 回退到 `initialize`。DiOS E2AG 33 项测试通过。本机用包含分支源码的 DiOS 镜像复验任务 `e72ec824b951`，首轮只显示获准的 `lookup`，越权请求返回 `MCP_TOOL_NOT_GRANTED`，任务结束后旧授权返回 `TOOL_GRANT_NOT_ACTIVE`。临时凭据文件已删除，上游只收到一次获准调用。
- [ ] 验证启用访问令牌的 DiOS 部署。接通限权事件凭据或可信网关，验证正确凭据成功、错误凭据返回 401。当前 DiOS 的后端全局令牌覆盖所有 API，调度器只将对应的 `Agent.env` 转交任务容器。
- [x] 一次性任务支持常用命名的显式 MCP 工具名单。真实 DSH 集成测试验证模型只看到所选工具，名单外的调用不会到达 MCP 服务，内置文件工具仍可见。代码与设计评审发现 DSH 的名称转换可能产生歧义，配置校验拒绝这些名称。
- [x] 兼容一次性任务的 `task.temperature`。真实 DSH 进程发出的 HTTP 请求验证缺省为 `0.7`，显式 `0` 在首轮和工具续轮均保留。Node.js 24 下 11 项测试通过，代码与设计评审通过。固定版 DSH 的请求钩子已弃用，升级 DSH 时复验该用例。
- [x] Linux 一次性任务接通旧 `shell` 工具名、参数和结果格式。用真实 DSH 验证相对工作目录、非零退出、stdout/stderr、超时与工具轮次预算。Linux 全套 11 项与 Windows 本地任务入口测试通过。代码和设计评审确认复用 DSH 执行管道，存量凭据兼容另验。
- [x] 兼容旧 Git 工作流注入的 `GIT_PLATFORM_TOKEN`。用 Linux 容器中的真实 DSH 和假凭据验证旧 `shell` 能读取部署值及 Git 业务变量，原生 Bash 和其他敏感变量继续走 DSH 默认过滤，工作区 `.env` 无法覆盖或补入该凭据。Linux 全套 11 项通过，代码和设计评审完成。

## 待推进

- [ ] 用实际存量工具名验收 `task.tools`。对会被 DSH 改写或产生名称歧义的配置，需在 MCP 发现时按原始名称选择。
- [ ] 完成 task 配置映射。核对剩余存量模型配置和 `subagents` 调用。验收依赖 Shell 登录环境、输出截断行为或其他业务凭据的存量任务。在目标环境用实际 Git 工作流验证鉴权。
- [x] TypeScript 常驻 HTTP 入口提供 `GET /health`。Node.js 24 实际 HTTP 测试确认返回 200 和旧版健康响应。隔离 Linux 容器用实际入口验证从容器网络地址访问端口 8000。代码和设计评审通过。
- [x] 常驻入口接通非流式、无工具单轮 Chat。用 DiOS A2A 请求形状通过实际 HTTP 和 DSH 验证角色、模型、无工具列表及 `choices[0].message.content`。
- [x] 新增 DSH 常驻服务镜像构建目标，默认构建仍为一次性任务镜像。隔离的本机 DiOS 启动并探测常驻容器，同一容器完成两次无工具 A2A 请求并登记 `reply`，模拟模型错误时登记 `failed`。代码与设计评审通过。
- [ ] 验证模型省略场景。DiOS 的 A2A service 当前只按模型显示名查找，模型 ID 或实际模型名可能导致请求省略 `model`。多模型配置需要明确默认模型或修正 DiOS 查找。
- [ ] 提供独立任务提交入口。外部调度器可提交任务、读取运行状态与结果。验收一个未部署 DiOS 的调用方使用自己的模型、MCP 和工作区完成任务。接口字段待定。
- [ ] 接通多轮会话、SSE、工具事件和人工审批提示，验证中断、会话隔离和旧历史迁移。
- [ ] 核实仍在使用的独立入口和配置。完成兼容验收后，将目标环境的 task 和 service 切换到 DSH，并演练按部署恢复旧镜像。

## 后续方向

- [ ] 支持 DiOS 为每个 Agent 选择要注册的 DiAgent 插件。DiOS 保存并下发插件选择，DiAgent 按选择装配已部署的插件。验收同一 DiOS 下两个 Agent 各自只获得自己配置的插件。
- [ ] 评估同一次任务的多个 Agent 共用容器。届时验证子任务的上下文、工具权限、文件读写和失败处理。暂缓实现。

## 已验证的本地基线

- TypeScript task 试点可启动固定版本的 DSH。已有测试覆盖指定 Skill、Streamable HTTP MCP、成功产物及模型失败退出。
- `npm run test:task` 在 Windows / Node 24.9 上构建成功，11 项集成测试全部通过。测试使用真实 DSH 子进程和本机模拟服务，覆盖合法事件提交一次、拒绝时零提交、HTTP 502 不重试、策略拒绝回显和专用凭据来源。
- `DIAGENT_ENABLE_DIOS_EVENTS=false` 可关闭一次性任务的 `publish_event`。红绿测试覆盖工具从模型列表移除、工作区 `.env` 无法改回启用、DiOS 零请求和非法值报错。双评审确认该开关适合在 profile 装配时处理，MCP 保持独立装配。
- `publish_event` 的代码评审发现自定义来源规则的字面方括号与 Python `fnmatch` 不兼容，已用红测复现并修复。倒序字符范围继续拒绝。另补了目录已注册且来源匹配、但来源未开放该类型时零次提交的覆盖。
- `publish_event` 的 HLD 评审确认沿用 Cordis 插件接口。后续 Chat 可直接复用插件，届时按实际调用提取公共装配逻辑，各入口仍按各自的工具选择规则启用。DiOS 负责审批、去重与派发。
