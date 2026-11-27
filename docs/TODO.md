# DiAgent v0.1 待办

按 [兼容基线](2026-11-diagent-v0.1-compatibility-baseline.md) 跟踪实现、测试、评审和部署验证。依赖同一入口的功能按顺序推进，每项验收证据在完成后补齐。

v0.1 的交付目标是用 TypeScript + DSH 完整替代现有 DiAgent。一次性任务和在线服务统一使用 DSH，旧镜像仅用于切换验证与回滚。

## 下一步 · DiOS 任务反馈与执行轨迹

- [ ] 从 DiOS 事件日志和活动总览打开同一份任务详情，按任务 ID 查到当前状态、成功结果、失败原因及本次执行已登记的产物。界面刷新后仍可查看终态。
- [ ] 复用 DSH 会话树事件，按任务保存用户可见的步骤、工具结果和子 Agent 进度。DiOS 支持运行中查看及结束后回放，状态与执行轨迹可互相定位。
- [ ] 接收 DSH `present` 声明，校验文件属于本次任务输出，再登记可下载的交付快照。用 Work Agent 各跑一条成功和失败的任务，验证成功结果和 Office 文件可下载，失败原因和已生成的部分产物可查看。

## 镜像交付

- [x] 从 `d9984e4` 生成同版本 Linux amd64 task、service 参考镜像。task 回归 11 项通过。`dios-diagent-service:dsh-d9984e4` 镜像 ID 为 `sha256:1791677fceef96ac1b3deabd88e7db02da0ea5ee0360b75b7eaf6f2427186a20`，服务回归 3 项通过。
- [x] 确定发布候选的锁定依赖。DSH 统一升级至 `0.2.2-rc.3`，YAML 升级至 `2.9.1`。DSH 仍固定旧的 `undici`、`fflate` 和 MCP client，临时覆写到 `8.12.2`、`0.8.3` 和 `2.3.0`。npm 生产依赖审计由 211 项降到 0 项，Linux task 11 项和 service 3 项回归通过。后续 DSH 若采用已修复版本，移除对应覆写并复验。
- [x] 新增 DSH 双镜像发布工作流。同一源码修订构建并测试两张镜像，手动发布使用完整提交 SHA，双镜像推送成功后记录两个仓库 digest。DiOS 三种部署 Compose 均验证了独立 digest 覆写及旧默认值。
- [x] 最终候选两张镜像在隔离 DiOS 联调通过。Reviewer 同标签切换与回滚的三次任务为 `25656792552a`、`7c87a9eaf282`、`29225b0083a6`。常驻服务复用同一容器完成两次单轮请求，并将模拟模型错误登记为 `failed`。工作流已离线验证两次推送成功和第二次推送失败的摘要行为。
- [ ] 在 GitHub Actions 运行发布工作流并登记两个仓库 digest。工作流需由仓库操作者执行。
- [ ] 让目标环境分别按 digest 选择 task 和 service，走现有 [Reviewer 切换与回滚验收](2026-11-reviewer-cutover.md)，并验证常驻容器实际使用的镜像和回滚。两类镜像可独立切换，常驻服务切换还需满足下方兼容项。

## 当前 ticket

- [x] 修复持久 Task 重建已选技能视图的 EEXIST。只复用私有目录内仍指向原授权位置的链接，拒绝根重定向、未授权条目及错误目标，不删除或覆盖未知数据。代码与 HLD 双审通过；自定义技能六项回归包含真实两个进程恢复已选镜像技能和自定义技能。完整 Task 标准名单 36 项、受影响 Chat 技能两项通过。验证使用现有镜像加编译代码，目标发布仍待验收。

- [x] 为宿主已批准的具名业务工具提供原生 DSH 桥接，使用真实调用标识与取消信号，通过受管模型代理访问宿主。显式部署开关与工具名单生效，不放开普通 MCP 或子 Agent 检查点。SDK 八项回归通过，含真实两个进程恢复已完成宿主调用、外部提交一次、401 不重试和最坏 JSON 转义。代码与 HLD 独立审查通过；宿主修复 schema 冻结和交付前未决调用核对。验证使用现有镜像加编译代码，正式服务、发布和目标部署待验收。宿主范围见 llm-agent 的 `docs/office-capability-parity.md`。
- [x] 为宿主固化的只读自定义技能包增加受管额外技能根，与已选镜像技能共同发现。配置须有部署开关、显式 skill 授权，禁止与具名子 Agent 共享。SDK 三项回归通过，含真实 DSH 读取授权技能；代码与 HLD 双审通过。宿主修复 profile 白名单、frontmatter 同名及 kebab-case、内置名字冲突、安全执行位与恢复冻结；Linux 14 项快照回归及真实 Docker 只读挂载通过。现有镜像加编译代码运行完整 Task 标准名单 33 项通过；尚未发布镜像或验证目标服务。
- [ ] 操作者将 `tests/task-host-tools.test.mjs` 和 `tests/task-custom-skills.test.mjs` 加入镜像 CI 的显式测试名单，发布包含新协议的镜像并登记宿主工具及自定义技能能力标签；标准 `test:task` 已包含这两个文件。

- [x] 为一次性任务的工具开始与结束事件保留有限长、白名单字符的调用标识，保留版本和既有字段，不写入原始工具参数。现有 runtime 镜像内的 DSH 0.2.2-rc.3 加本地编译代码挂载验证三个协议用例通过，含乱序完成、标识过滤和真实跨进程暂停恢复。代码与 HLD 独立评审通过，已修复干净目录初始化和标准测试入口遗漏；代码 reviewer 在全新 cwd 独立复验两个工具用例通过。一次 HLD 复验在 DSH 初始化阶段 10 秒超时，重跑三项通过。尚未发布新镜像或验证目标部署。
- [ ] 操作者将新增 `tests/task-tool-events.test.mjs` 同步到镜像 CI 的显式测试名单，并发布包含该协议的新镜像。`npm run test:task` 已纳入新测试，现有镜像依赖加编译代码挂载运行完整名单 22 项通过；宿主对旧无标识协议只兼容串行，并行明确拒绝。

- [x] 保留任务模型配置声明的图片输入能力。Linux Node 24 的 20 项一次性任务回归通过，覆盖图片声明、文本默认行为，以及托管模型桥对超过 1 MiB 的图文请求的转发。代码与设计评审确认配置解析和 DSH profile 共用现有链路，网关与任务代理的图文请求上限均为 32 MiB。已验证 DiOS 中的 `deepseek-flash` 接收普通文本和图片，Office A/B 使用包含此改动的本地镜像。

- [x] 用同一条多文档任务对照原版 Office runner 和启用图片的 DiAgent。修复托管模型桥的 413 后，DiAgent 在本地经 `deepseek-flash` 完成 PPT、Word 和 Excel 的交付，确认图文请求与归档可读。原版对照达到 35 分钟测试时限，只留下 PPT 和 Word 草稿。

- [x] 一次性任务支持可选事件、结构化终态和持久检查点。代码和设计评审验证请求前暂停、工具输出保留、授权重发、结果大小和 Unicode 边界。Linux 用固定版 DSH 和模拟模型在另一进程恢复会话，已写文件只产生一次副作用。任务和常驻服务等离线回归 55 项通过，另有一项非 Linux 平台用例在 Linux 跳过。目标部署待验证。

- [x] 一次性 CLI 任务支持显式 `office` 授权。代码和设计评审确认复用受管模型代理和工作区路径校验，保留具名子 Agent 隔离。锁定版 DSH Linux 回归验证 Office 与自定义 Skill 共存、工具按需激活、拒绝工作区外文件。独立 HTTP 控制器提前拒绝无法注入受管模型授权的 Office profile。隔离容器内使用模拟模型完成 DOCX/PPTX 新建、修改和 PDF 转换。目标部署联调待验证。

- [x] 恢复一次性任务默认配置的 DSH Office Skills 和工具，保留显式工具名单与具名子 Agent 的授权。Linux 回归 20 项通过。锁定版 DSH 使用模拟模型加载 Office Skill，生成 Word 和 PPT 并通过 `office_convert` 转为 PDF。镜像内置字体可直接渲染中文 PPT。代码和设计评审确认模型回看预览图还需声明图片输入能力。
- [x] 常驻 Chat 接收 DiOS 下发的推理预算。DSH 在生成请求前拦截超额步骤，工具轮次复用已有插件。隔离 Docker 验证 SSE 阻塞时一步预算只发出一次生成请求。常驻回归 30 项通过、1 项按平台跳过，任务和独立 API 17 项通过。代码与设计评审已核对两种入口和预算边界。
- [x] 常驻 DSH 服务接回独立部署的旧工具目录、同步 CloudEvent、`session_id` 与会话管理。Linux Docker 常驻回归 27 项通过、1 项按平台跳过。代码和设计评审确认目录与旧工具选择共用发现规则，受管模式通过 DiOS 查询工具与管理会话，事件仍校验模型授权。
- [x] 本地 v0.1 统一验收。当前两个工作区构建 DSH task/service 和 DiOS 前端。DiAgent Linux 回归 38 项通过（1 项非 Linux 专用跳过），DiOS 后端 63 项通过。Reviewer 旧 Python、DSH、回滚三轮任务为 `65bcd0172b81`、`1344d8bb6f06`、`cddcfdc5bea9`。中间一轮运行中重启 DiOS，恢复后仍登记产物和完成事件。Chromium 在事件日志看到 `dispatched`，活动总览显示三个任务均已完成。
- [x] 统一验收覆盖常驻 A2A 镜像切换与回滚、旧 DiOS 会话续聊、受管 Chat 的 Shell、Skills、MCP、事件审批，以及独立 API 的进程重启和结果回收。常驻回滚使用兼容模式和模拟模型。另用一条合成提示验证真实 `ecnu-max` 经 DiOS 代理完成 SSE，常驻容器无供应商密钥和模型目录文件。
- [ ] 目标环境验收。在发布候选镜像 digest 后，用目标的 MCP、业务凭据和存量配置完成切换与回滚。具名 `subagents`、执行器内 `cron/interval` 和旧 checkpoint 配置仍需按存量调用核实迁移方式。
- [x] 核对本机存量配置并补齐试点步骤。DiOS 本机 SQLite 有 0 个 Agent 和 0 条订阅。旧 DiAgent 的独立任务示例配置了三个具名子 Agent。目标环境的只读盘点、两张镜像的切换与回滚步骤见 [目标环境验收](2026-11-reviewer-cutover.md)。
- [x] 验证具名子 Agent 的 DSH 迁移路径。锁定版 Linux 镜像通过两轮模拟模型验证，主 Agent 能按名委托 reviewer，子会话收到专用角色提示，主 Agent 收到子结果。仅追加 preset 时子模型仍看得到宿主工具。证据和兼容方案见 [具名子 Agent 迁移验证](research/2026-11-dsh-named-subagent-migration.md)。
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
- [x] 接通 DiOS 限权事件凭据。独立凭据只覆盖事件目录、来源规则和手动提交，发布时按 Agent 授权核验来源与类型。接口测试覆盖 401、403 和一次获准发布，隔离 Docker 联调验证发布后的审批提示与 Agent ID 登记。
- [x] 一次性任务支持常用命名的显式 MCP 工具名单。真实 DSH 集成测试验证模型只看到所选工具，名单外的调用不会到达 MCP 服务，内置文件工具仍可见。代码与设计评审发现 DSH 的名称转换可能产生歧义，配置校验拒绝这些名称。
- [x] 兼容一次性任务的 `task.temperature`。真实 DSH 进程发出的 HTTP 请求验证缺省为 `0.7`，显式 `0` 在首轮和工具续轮均保留。Node.js 24 下 11 项测试通过，代码与设计评审通过。固定版 DSH 的请求钩子已弃用，升级 DSH 时复验该用例。
- [x] Linux 一次性任务接通旧 `shell` 工具名、参数和结果格式。用真实 DSH 验证相对工作目录、非零退出、stdout/stderr、超时与工具轮次预算。Linux 全套 11 项与 Windows 本地任务入口测试通过。代码和设计评审确认复用 DSH 执行管道，存量凭据兼容另验。
- [x] 兼容旧 Git 工作流注入的 `GIT_PLATFORM_TOKEN`。用 Linux 容器中的真实 DSH 和假凭据验证旧 `shell` 能读取部署值及 Git 业务变量，原生 Bash 和其他敏感变量继续走 DSH 默认过滤，工作区 `.env` 无法覆盖或补入该凭据。Linux 全套 11 项通过，代码和设计评审完成。

## 待推进

- [x] 常驻 Chat 接受 DiOS 随请求发送的纯文本历史。Linux 服务 HTTP 回归通过，隔离 DiOS 使用 `/api/apps/chat/completions` 连续两次请求同一会话，模拟模型核对第二次收到之前的用户/助手消息及本轮消息，角色和顺序一致。
- [ ] 用实际存量工具名验收 `task.tools`。对会被 DSH 改写或产生名称歧义的配置，需在 MCP 发现时按原始名称选择。
- [x] 一次性任务入口支持具名委托。锁定版 Linux DSH 回归覆盖 reviewer 沿用任务模型、只读角色被拒绝写入、仅子 Agent 有写权限时将报告写入任务产物目录、主 Agent 收到子结果、无工具子 Agent。代码和架构评审确认复用现有运行器和权限过滤。评审后补齐省略父工具名单的兼容，并用子 Agent 的 `tool_selection.tool_ids` 区分原生文件权限与旧 MCP 工具名单。
- [x] DiOS 下发具名子 Agent 配置。在 Agent 能力 JSON 保存独立工具名单，通过 A2A 下发私有任务配置。代码与架构评审完成。隔离 Docker 任务 `a8d83f7aff4a458e824c55f2ec2cf7bd` 中主 Agent 只获得委托和等待工具，reviewer 只获得 `write`，父子沿用同一模拟模型。reviewer 写出报告，DiOS 登记 `completed` 并收回 `task_result.md`。
- [x] 接入具名子 Agent 的独立 Skills 和 MCP。隔离 Docker 任务 `5c84c0a3f0f4402796a846620afd086a` 验证三个角色使用同一模型，主 Agent 把两个 MCP 角色的结果交给 reviewer。上游只收到各角色获准的一次调用。reviewer 加载专用 Skill 并写出附加报告，DiOS 登记主结果。重复演练模拟子角色推理失败，任务 `d40c62eca632496a8ef8114f5411c433` 的主 Agent 收到失败通知并正常收尾，两次任务的四张角色 MCP 授权都撤销。两路评审后收紧主 Shell 组合及独立 HTTP 对子角色配置的校验。
- [x] 在 DiOS 回收并展示附加 Markdown 报告。任务 `09bdd6bdcdd2458ea8619dfb57de983f` 使用本地 DSH 容器与模拟模型，验证 A2A 登记 `task_result.md` 和 `reviewer-report.md`，通过鉴权下载，并在 Chromium 的活动总览打开任务、预览并下载字节一致的报告。后端回归验证工作区后续改动、其他运行目录、链接和无效文件不会污染产物快照。两路评审完成，活动查询只取元数据和产物数，抽屉支持刷新。
- [ ] 按目标环境使用情况核对旧版子工具名单、上游会话、取消与预算耗尽时的边界。
- [ ] 核对依赖 Shell 登录环境、输出截断行为或其他业务凭据的存量任务。在目标环境用实际 Git 工作流验证鉴权。
- [x] TypeScript 常驻 HTTP 入口提供 `GET /health`。Node.js 24 实际 HTTP 测试确认返回 200 和旧版健康响应。隔离 Linux 容器用实际入口验证从容器网络地址访问端口 8000。代码和设计评审通过。
- [x] 常驻入口接通非流式、无工具单轮 Chat。用 DiOS A2A 请求形状通过实际 HTTP 和 DSH 验证角色、模型、无工具列表及 `choices[0].message.content`。
- [x] 新增 DSH 常驻服务镜像构建目标，默认构建仍为一次性任务镜像。隔离的本机 DiOS 启动并探测常驻容器，同一容器完成两次无工具 A2A 请求并登记 `reply`，模拟模型错误时登记 `failed`。代码与设计评审通过。
- [x] 复验常驻 A2A 的存量模型引用。在注册两个模型的测试库中，Agent 以模型 ID、配置名或供应商模型名保存引用，DiOS 都向 DiAgent 显式下发正确模型。模型代理相关 15 项回归通过。
- [x] 提供独立任务提交入口。外部调度器通过 HTTP 提交、轮询状态、下载产物。隔离 Docker 中未启动 DiOS，外部调用方提交文件，DSH 经模拟模型加载 Skill 并调用 MCP，宿主机 API 重启后使用原任务 ID 下载结果并确认容器已回收。独立接口 5 项通过，Linux 全套 38 项通过。双评审后修复 `created` 容器长期停在 `starting`、工作区覆盖部署配置及供应商凭据随 profile 挂载的问题。单控制器和重复提交语义见 [README](../README.md#独立任务-http-接口)。
- [x] 接通无工具文本 SSE。Linux 服务回归 7 项、共享运行时的一次性任务回归 11 项通过。隔离 DiOS 的 Chat API 两轮流式对话保持历史顺序。模型完成前可收到首段，正常完成发送 `stop` 和 `[DONE]`，首段后断流发送错误帧并阻止模型重试。文本在临时会话内使用 DSH 实验性插件记录进入 SDK 通道，升级 DSH 时复验。HTTP 写入等待 `drain`，SDK 队列的慢客户端负载待验证。
- [x] 接通在线 Chat 的 `tool_selection.tool_ids`。隔离的本机 DiOS 通过 Chat API 发起两轮流式对话，模拟模型只收到 DiOS 下发的 `shell` 和 `publish_event`。Linux 服务 13 项、Windows 平台限制 1 项、一次性任务 11 项通过。服务测试独立验证真实 Shell 执行和向模拟 DiOS 单次提交事件。
- [x] 补齐在线 Shell 的模型凭据检查。拒绝使用部署环境中的模型 key，或在切换模型目录后仍保留带 key 的工作区 `models.yaml` 的 Shell 请求。纯问答继续使用部署凭据鉴权。两个新增用例均先复现 HTTP 200 再验证 HTTP 400，Linux 常驻服务回归 15 项通过，代码和设计评审完成。
- [x] 接通常驻服务的受管推理。DiOS 保管供应商密钥，向 Chat 与常驻 A2A 发放绑定 Agent 与模型的单轮限额授权。真实 DSH Docker 容器经 DiOS 转发到模拟供应商完成 SSE、Shell 续轮和 A2A 结果登记，容器环境与工作区未下发供应商密钥或模型目录。DiAgent Linux 服务回归 16 项通过。[DiOS 草稿 PR #62](https://github.com/HQIT/DiOS/pull/62)
- [ ] 在目标环境用实际模型、MCP 和事件凭据复验常驻与一次性任务的受管推理，清理旧工作区和备份中的历史模型及 MCP 凭据，并验证回滚。
- [x] 在隔离的本地 Docker 用真实 `ecnu-max` 凭据验收一次性任务刷新。任务 `8cd5a197fbd64ae8b4f54782dc79933f` 执行一次 Shell，完成两次真实模型请求，两次请求之间成功换发令牌，并回收了预期文本。访问令牌设为 2 秒，模型凭据配置存于验收 DiOS 容器的内存文件系统。
- [x] 常驻 Chat 发送工具开始、结果、失败与事件审批提示。工具前文字使用 `reasoning_content`，DiOS 只保存正式回答。旧 Shell CLI 确认提示独立分帧，并按当前会话显示。Linux 服务 20 项、DiOS 后端 59 项和前端构建通过，覆盖客户端主动断开、并发流和会话所属 Agent 校验。代码与设计评审完成。
- [x] 受管 Chat 和常驻 A2A 装配按 Agent 分配的 Skills。隔离 Docker 联调验证文件型 Skill 的附属文件、控制台录入的 Skill 清单与未分配目录排除。目录只读挂载，随 Agent 重建更新分配。DSH 复用一次性任务的 Skill 发现逻辑。
- [x] 受管 Chat 和常驻 A2A 装配按 Agent 授权的 Streamable HTTP MCP。隔离 Docker 中模型只看到并调用获准 `lookup`，容器没有 `mcp_servers.json` 或上游 MCP 凭据。接口回归验证空工具名单、工具发现和调用过滤、上游会话 ID 绑定及轮次撤销。已绑定会话在轮次结束时有界关闭。
- [x] 盘点本机 DiOS、旧 DiAgent、DiAgent-TS 和同工作区业务代码中的旧会话调用。只找到 DiOS 的 Chat/A2A 入口使用 DiAgent Chat 接口，未发现直连旧 `/v1/sessions` 或依赖 DiAgent 自存 `session_id` 的业务代码。已补旧式 DiOS 数据记录续聊的接口回归。
- [ ] 在目标环境盘点仓库外的旧会话调用方。分别使用已有 DiOS Chat 会话和实际直连客户端复验续聊，核对服务切换时独立进程内历史的处理。
- [ ] 核实仍在使用的独立入口和配置。完成兼容验收后，将目标环境的 task 和 service 切换到 DSH，并演练按部署恢复旧镜像。

## 后续方向

- [x] 统一 Task 与 Chat 的 profile 生成。保留现有 DSH 装配和各入口的能力规则。默认 Chat 的空工具和 Skills 配置测试先失败再通过。用新旧 Linux 镜像比较两种 Task 配置，生成的补丁逐字一致。Linux 全套 39 项通过，1 项仅在非 Linux 运行，代码与设计评审完成。配置清单见 [架构设计](2026-11-diagent-dsh-architecture.md#基础与两种默认配置)。

- [x] DiOS 为受管 Chat 和常驻 A2A 保存每个 Agent 的 `capabilities.diagent_tools`，复用 DiAgent 的工具选择和轮次授权。Docker 验收覆盖同一镜像中两个 Agent 的工具差异及更新后下一轮生效，容器继续复用。DiOS 后端 67 项测试与前端构建通过。代码和设计评审后补齐 MCP 服务保存校验与控制台错误反馈。
- [x] 一次性 Task 接入按 Agent 配置工具。显式名单支持 `skill`、`mcp` 和 `publish_event`，旧 `task.tools` 继续过滤 MCP 名称。Docker 验收中，空名单任务不向模型提供工具，另一任务只提供注册的内联 Skill 与 E2AG 放行的 `lookup`，两项产物均由 DiOS 回收。启动配置进入目标容器私有目录，未写入工作区。双评审完成，DiOS 后端 69 项通过，Linux DiAgent 回归 39 项通过、1 项仅非 Linux 运行。
- [x] 一次性 Task 复用 DiOS 模型代理。Docker 验收跑通真实 DSH 的纯问答与 Skill/MCP 任务，确认模拟供应商密钥和地址未进容器，任务完成后的授权返回 401。DiOS 后端 72 项通过，覆盖错误模型、取消、启动中的取消竞争，以及已签发授权但尚未启动的容器在重启后回收。代码与设计评审完成。
- [x] 对齐受管 Task 的推理授权与任务超时，额外留 2 分钟供容器启动。双评审后补齐到期与扣减额度竞态，验证两小时任务在第 121 分 59 秒仍可推理，截止时返回 401，耗尽额度返回 429。最终模型代理 14 项回归和本地 DSH Docker 验收通过。
- [x] 受管 Task 使用独立刷新凭据换发访问令牌，并继续原 DSH 会话。DiOS 保留模型、剩余额度和任务截止，任务终态撤销授权。两个工作区的最终 Docker 验收使用 2 秒访问令牌完成纯问答、MCP 和 Shell 三项任务，共成功换发 5 次。接口验证取消后拒绝刷新，DiOS 后端 74 项通过。
- [x] 开启 Task 模型代理和刷新后，支持显式授予 `shell`、`read`、`write` 和 `edit`。Linux DSH 验收覆盖 Shell 和工作区读写，拒绝原生文件工具访问工作区外目标；Shell 继承不到刷新文件路径，DiOS 产物收集拒绝符号链接。代码和设计评审完成。文件工具的前置校验与 DSH 实际打开仍分两步。
- [ ] 补齐兼容模式一次性任务的启动恢复，并复核已分配给 Task 的 Skill 改名或删除时的行为。受管推理下已签发授权的启动窗口已有恢复覆盖。
- [ ] 评估同一次任务的多个 Agent 共用容器。届时验证子任务的上下文、工具权限、文件读写和失败处理。暂缓实现。

## 已验证的本地基线

- TypeScript task 试点可启动固定版本的 DSH。已有测试覆盖指定 Skill、Streamable HTTP MCP、成功产物及模型失败退出。
- `npm run test:task` 在 Windows / Node 24.9 上构建成功，11 项集成测试全部通过。测试使用真实 DSH 子进程和本机模拟服务，覆盖合法事件提交一次、拒绝时零提交、HTTP 502 不重试、策略拒绝回显和专用凭据来源。
- `DIAGENT_ENABLE_DIOS_EVENTS=false` 可关闭一次性任务的 `publish_event`。红绿测试覆盖工具从模型列表移除、工作区 `.env` 无法改回启用、DiOS 零请求和非法值报错。双评审确认该开关适合在 profile 装配时处理，MCP 保持独立装配。
- `publish_event` 的代码评审发现自定义来源规则的字面方括号与 Python `fnmatch` 不兼容，已用红测复现并修复。倒序字符范围继续拒绝。另补了目录已注册且来源匹配、但来源未开放该类型时零次提交的覆盖。
- `publish_event` 的 HLD 评审确认沿用 Cordis 插件接口。后续 Chat 可直接复用插件，届时按实际调用提取公共装配逻辑，各入口仍按各自的工具选择规则启用。DiOS 负责审批、去重与派发。
