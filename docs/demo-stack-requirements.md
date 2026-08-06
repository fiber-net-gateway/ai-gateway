# 可演示闭环需求

## 1. 背景

控制台已经具备用户与 Token、Provider/模型草稿、不可变 Release、rnacos 逐资源发布、
访问审批和调用审计接收能力，但从一个全新 checkout 仍无法用一条命令得到可操作的完整演示：

- BT1 bootstrap key 保存在 MySQL，却没有控制台内的 Key Ring 发布入口；
- 左侧环境切换器没有改变业务页实际使用的环境；
- ai-server 没有可直接使用的演示 Provider 和初始模型；
- ai-server 审计只写 NDJSON 文件，没有到控制台接收接口的发送链路；
- 仓库没有生产镜像、反向代理和多服务编排。

本需求以“本地、单机、可重复演示”为边界。它不会把 rnacos 发布成功描述为 ai-server
实例已经接受配置，也不会把 Docker Compose 当作生产高可用方案。

## 2. 演示目标

执行 `./scripts/init-demo-env.sh` 并以生成的 `.env.docker` 运行
`docker compose --env-file .env.docker up --build` 后，演示环境必须包含：

1. 一个 MySQL 实例，使用相互隔离的 `ai_server_console` 与 `cat` schema；
2. 一个 rnacos 实例，提供 ConfigService 和 NamingService；
3. 一个 CAT 3.x 服务端，接收 ai-server 的 CAT transaction；
4. 控制台 API 与静态 Web 入口；
5. 一个 ai-server 实例；
6. 一个只用于演示的本地 OpenAI-compatible Provider；
7. 一次性初始化任务和审计转发 sidecar。

首次启动应自动完成以下安全、幂等的初始化：

- 使用控制台 API 发布 bootstrap BT1 Key Ring，并进行 rnacos MD5 回读；
- 当演示 Provider/模型不存在时创建草稿，冻结为 Release 并执行发布；
- 已有相同演示资源或已发布 Release 时不得重复创建；
- 不向日志打印 BT1 secret、Provider token、MySQL/rnacos 密码或审计上报 token。

## 3. 功能需求

### 3.1 BT1 Key Ring

- 管理员可以查看某环境的 key 安全元数据：`kid`、状态、是否用于签发、时钟偏差、
  指纹后缀和 revision。
- API 和 UI 不得返回 key secret。
- 管理员可以将可用 key 渲染到固定 Data ID
  `ploto.ai-llm.auth.bt1.keys`、固定 group `LLM-SERVER`。
- 发布必须执行写前读取、可选 CAS、写入和 MD5 回读；回读一致后，
  `PUBLISHED_UNVERIFIED` key 才可转为 `ACTIVE`。
- 页面分别展示数据库 key 状态和 rnacos 证据，不得显示“实例已生效”。

本阶段不提供在线生成、轮换或销毁 key 的 UI。轮换仍需后续实现双 key 重叠、旧 Token
最晚接受时间检查和安全销毁审批。

### 3.2 环境切换

- 用户有多个授权环境时，可以从左侧环境控件选择环境。
- 模型、Provider、Release、权限审批、我的权限和调用记录必须使用同一个所选环境。
- 选择可保存在浏览器本地；当权限列表变化或保存的环境已无权访问时回退到第一个授权环境。
- Token 页面仍可在自身表单中明确选择签发目标环境。

### 3.3 演示 Provider 与自动初始化

- 演示 Provider 只在内部 Docker 网络监听，提供 `/health` 与
  `/v1/chat/completions`。
- Provider 返回固定、可辨识的 OpenAI-compatible 同步响应，供验证代理、CAT 和审计链路；
  它不连接公网，也不模拟真实模型质量。
- 初始化器只能在开发认证模式的演示 Compose 中使用；它通过公开控制台 API 完成操作，
  不直接改业务表。
- 初始化器必须等待每个异步 Release 到达终态，并在失败时以非零状态退出。

### 3.4 审计转发

- sidecar 只读挂载 ai-server 审计 NDJSON 文件，并批量调用
  `/api/internal/llm-call-audits/batches`。
- 单批最多 100 条；只发送完整且可解析的 schema-v5 行。
- offset 必须持久化；网络失败不得推进 offset，重发由服务端幂等键去重。
- 不记录原始审计行或请求/响应正文。
- 文件被截断或重新创建后，从新文件开头继续；演示配置关闭审计文件轮转以避免跨归档游标问题。

## 4. 状态与证据边界

演示必须继续区分：

- MySQL 草稿/不可变 Release：期望配置；
- rnacos 写入和精确 MD5 回读：发布证据；
- ai-server `/health` 与 `/ready`：进程存活和完整快照就绪；
- 指定 Release/Data ID 被每个实例接受：本阶段仍无实例级证据，保持 `UNKNOWN`。

`/ready = 200` 可以证明该实例有一个完整可服务快照，但不能反推出它对应控制台中的某个
Release，也不能代替逐实例 Data ID/MD5 接受矩阵。

## 5. 非目标

- 生产级 TLS、OIDC、外部 secret manager 和 Docker Swarm/Kubernetes；
- CAT、rnacos 或 MySQL 的集群高可用；
- Release 审批/驳回、取消、手工回滚和 SSE 事件流；
- 环境 CRUD、授权撤销、通用用户组治理；
- ai-server 主动实例状态上报或 NamingService 实例矩阵；
- BT1 key 在线轮换、退役和销毁。

## 6. 验收

- `npm run typecheck`、`npm test`、`npm run format:check`、`npm run build` 通过；
- Compose 文件可以被 YAML 解析，所有 build context、挂载文件和依赖目标存在；
- 控制台单元测试覆盖 Key Ring secret 不出现在响应、发布目标固定、MD5 回读和状态晋升；
- 审计转发器单元覆盖完整行、残缺行、批次 offset 边界和敏感字段剥离；
- 在具备 Docker 的环境中，按 README 的 smoke test 可以验证 Web、API、rnacos、CAT、
  ai-server health/ready、代理调用和个人调用记录。
