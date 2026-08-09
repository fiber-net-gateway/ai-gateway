# AI Gateway

[English](README.md) | 简体中文

AI Gateway 是完整的 LLM 网关系统，包含 C++ 数据面、Web 管理控制面、动态配置与服务发现、
发布流程、审计和可观测性。本仓库同时维护 `ai-server` 与管理控制台，不再只是外部
`fiber-gateway-cpp/apps/ai-server` 的控制台。

项目面向平台管理员、应用开发者和运维人员，为应用代理 LLM 流量，但不是终端用户聊天页面。

## 核心能力

`native/ai-server/` 数据面提供：

- OpenAI Chat Completions 和 Anthropic Messages 兼容接口；
- BT1 认证、模型授权、确定性 Provider/token 选择、路由、重试、fallback、熔断与 SSE 流式
  透传；
- 基于 rnacos 的动态配置、`service://` 发现、实例注册与不可变运行时快照；
- 通过 owner 选择和 check/settle 协调实现的集群 token 限流；
- Prometheus 指标、CAT 链路、结构化日志，以及编译期选择的 `HTTP` 或 `FILE` 审计传输。

`web/` 与 `server/` 控制面提供：

- 用户管理、BT1 Token 签发、环境切换和个人调用记录；
- 中文/英文控制台切换，自动识别浏览器语言并持久保存用户选择；
- Provider、模型、授权组和 BT1 Key Ring 的结构化管理，secret 保持只写；
- 草稿校验、不可变 Release、固定 Data ID 发布、CAS 保护、MD5 回读、访问申请和发布证据；
- 向 rnacos 注册 console API 服务，接收 `ai-server` 通过服务发现提交的有界异步审计批次。

系统已经可以端到端运行。逐实例配置生效采集、Release 审批/驳回/取消操作和人工回滚仍是
控制面后续能力；在取得带类型的实例证据前，生效状态会有意保持为 `UNKNOWN`。

## 技术架构

```mermaid
flowchart LR
    U[业务应用] -->|OpenAI 或 Anthropic API<br/>BT1| S[C++ ai-server 数据面]
    S -->|路由、重试、fallback、流式透传| P[LLM Provider]
    B[运维浏览器] --> W[console 容器<br/>Nginx + React]
    W -->|容器内 /api| A[Fastify 控制面]
    A -->|用户、草稿、Release、审计| D[(MySQL)]
    A -->|发布固定 Data ID<br/>注册 console API| R[rnacos<br/>配置 + 服务发现]
    R -->|配置快照与发现实例| S
    S -->|注册实例| R
    S -->|最小化异步审计| A
    S --> O[CAT + Prometheus + 日志]
    A -.->|生效状态采集待实现| S
```

- `native/ai-server/`：本仓库维护的 C++23 LLM 代理和数据面，通过 CMake 使用固定版本的
  Fiber runtime、HTTP、Nacos、CAT 和 Prometheus 模块；
- `web/`：React、TypeScript 和 Vite 控制面前端；开发时将 `/api` 代理到本地后端；
- `server/`：Fastify 控制面 API；MySQL 模式启用持久化领域 Store、rnacos 发布、console
  服务注册和审计接收；memory 模式仅用于隔离的 UI/API 开发，不向 rnacos 发布；
- MySQL：保存环境元数据、用户与会话、规范化配置、草稿、不可变发布记录、访问申请和审计
  数据；
- rnacos：承载固定 `LLM-SERVER` 配置 Data ID，以及 `ai-server`、Provider、限流成员和
  console 审计端点的 NamingService 注册；
- 可观测性：CAT 记录请求与 Provider attempt 链路，Prometheus 暴露稳定指标，审计管线生成
  每用户调用记录投影。

动态配置固定使用 rnacos group `LLM-SERVER`，主要 Data ID 为：

- `ploto.ai-llm.auth.bt1.keys`
- `ploto.ai-llm.models`
- `ploto.ai-llm.provider.<provider-name>`
- `ploto.ai-llm.user-group.<group-name>`

rnacos 的写入成功只表示“已发布”，不能直接表示所有 `ai-server` 实例“已生效”。发布中心
分别展示草稿和 rnacos 写入状态，并在缺少实例证据时保持 `UNKNOWN`。

## 项目结构

```text
.
├── web/                    # React 管理控制台
│   ├── src/
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── server/                 # Node.js + TypeScript API
│   ├── src/
│   │   ├── config/         # 环境变量解析
│   │   ├── database/       # MySQL 连接、确定性迁移
│   │   ├── modules/        # 用户、模型广场、访问审批、rnacos 与调用审计
│   │   ├── app.ts          # Fastify 应用与路由注册
│   │   └── index.ts        # 进程入口
│   └── .env.example
├── native/                 # C++ 数据面与固定 Fiber 集成
│   ├── CMakeLists.txt      # 原生顶层构建与审计传输选择
│   └── ai-server/          # 本仓库维护的网关运行时、文档与测试
├── deploy/                 # Nginx、ai-server、MySQL/CAT 镜像输入
├── scripts/                # 本地演示凭据初始化
├── compose.yaml            # 可重复的端到端演示栈
├── .temp/fiber-gateway-cpp # 仅用于源码研究的上游本地副本
└── package.json            # npm workspaces 与全仓库命令
```

`.temp/` 和所有 `dist/` 都是忽略目录，不能被业务代码导入或提交。

## 控制面本地开发

要求 Node.js 20 或更高版本。首次安装依赖：

```bash
npm install
cp server/.env.example server/.env
```

默认 `APP_DATA_MODE=memory`，无需外部服务即可预览；数据会在进程退出后清空。使用初始
管理员 `admin` 登录。启动前端和后端：

```bash
npm run dev
```

- 前端默认地址：`http://localhost:5173`
- 后端默认地址：`http://localhost:3000`

也可以分别启动：

```bash
npm run dev:web
npm run dev:server
```

健康连通接口：

```bash
curl http://localhost:3000/api/hello
```

返回：

```json
{
  "message": "Hello World!",
  "service": "ai-server-console-api"
}
```

该接口不依赖 MySQL、rnacos 或 `ai-server` 在线，因此可用于确认本地链路。以上命令只启动
控制面；完整网关请使用下文原生构建命令或 Compose 栈。

## Docker 端到端部署

Docker Compose 会启动完整可运行的网关：MySQL、rnacos、CAT、合并后的控制台、`ai-server`、
确定性的 OpenAI-compatible 测试 Provider 和一次性配置初始化器。第一次构建 `ai-server`
镜像会用固定版本的 Fiber 模块编译本仓库 C++ 数据面，可能需要数分钟。

先生成不纳入版本控制的凭据，再构建并启动。默认只允许本机访问各服务；如需从可信
局域网访问，生成环境文件时同时指定统一监听地址和本机局域网地址：

```bash
DEMO_BIND_ADDRESS=0.0.0.0 CONSOLE_PUBLIC_HOST=172.23.222.82 ./scripts/init-demo-env.sh
docker compose --env-file .env.docker up --build
```

可访问：

- 控制台：`http://172.23.222.82:5173`，使用 `admin` 登录；
- `ai-server`：`http://172.23.222.82:8080`，接受 rnacos 快照后 `/ready` 返回成功；
- 演示 Provider：`http://172.23.222.82:8081/health`；
- CAT：`http://172.23.222.82:8082/cat/r`；
- rnacos API：`http://172.23.222.82:8848`；
- rnacos 控制台：`http://172.23.222.82:10848/rnacos/`，随机登录信息只保存在
  `.env.docker`。

初始化器会发布 BT1 Key Ring，并创建指向本地 Provider 的 `fiber-demo` 模型。在控制台签发
BT1 Token 后，即可调用真实代理：

```bash
curl http://172.23.222.82:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <BT1 token>' \
  -d '{"model":"fiber-demo","messages":[{"role":"user","content":"hello"}]}'
```

调用会显示在 CAT 中；`ai-server` 直接提交最小化审计记录后，也会进入当前用户的调用记录。
`/ready` 健康是本演示实例的运行时证据，但控制台仍会把 Release 生效状态保持为 `UNKNOWN`，
直到实现带类型的逐实例生效观察器。

局域网发布会开放控制台、`ai-server`、演示 Provider、CAT 和 rnacos；MySQL 始终保持仅本机
监听。演示环境包含无密码开发认证和测试端点，只应暴露在可信网络；共享或不可信网络必须
改用生产认证并配置防火墙。

使用 `docker compose --env-file .env.docker down` 停止。只有在确认要删除全部演示 MySQL、
rnacos 和审计数据时才添加 `--volumes`。生成的环境文件权限为 `0600` 且被 Git 忽略；不要在
共享部署中复用演示凭据。

### 使用 MySQL

先创建数据库和最小权限账号，然后在 `server/.env` 中设置：

```dotenv
APP_DATA_MODE=mysql
MYSQL_HOST=127.0.0.1
MYSQL_USER=ai_server_console
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=ai_server_console
```

后端启动时会自动执行 `server/src/database/migrations/` 下尚未应用的迁移。生产环境设置
`NODE_ENV=production` 后必须使用 MySQL，并显式提供随机的 `APP_ENCRYPTION_KEY`。

## 配置

复制 `server/.env.example` 后可配置以下连接：

- `MYSQL_*`：控制台数据库；
- `RNACOS_*`：rnacos 地址、绑定环境、namespace、tenant、认证信息、固定配置 group 与可选的
  console API 服务注册；
- `AI_SERVER_BASE_URL`：为后续 `ai-server` 状态客户端预留的目标地址；启动时会校验，但当前后端
  不会调用该地址；
- `AUDIT_INGEST_TOKEN`、`AUDIT_INGEST_BODY_LIMIT_BYTES`：控制台内部调用审计接收接口的可选
  Bearer 凭据与请求体上限；token 为空时关闭入口；Compose 会把同一随机值提供给 `ai-server`；
- `AUTH_MODE`、`OIDC_*`：本地开发认证或企业 OIDC + PKCE；
- `APP_ENCRYPTION_KEY`：Token 短期交付与本地 secret 封装密钥；
- `BOOTSTRAP_*`：初始管理员、环境和 BT1 签名 key；
- `APP_HOST`、`APP_PORT`、`APP_PUBLIC_URL`：控制台监听和浏览器地址。

不要提交 `server/.env`，也不要在日志、API 响应或审计差异中返回 MySQL 密码、rnacos
密码、Provider token、BT1 secret 或审计上报 token。每用户调用记录的最小化契约见
[`docs/llm-call-audit-requirements.md`](docs/llm-call-audit-requirements.md)。

## 校验与构建

在仓库根目录运行：

```bash
npm run typecheck
npm test
npm run format:check
npm run build
npm run configure:native
npm run build:native
npm run test:native
```

构建结果分别生成在 `web/dist/` 和 `server/dist/`。根 `Dockerfile` 提供 `server`、`tools`
和 `console` 三个 target；console target 在同一个容器内运行 Nginx 与 Fastify。原生构建默认使用
`-DAI_SERVER_AUDIT_TRANSPORT=HTTP`；改为 `FILE` 可保留 NDJSON 文件审计。

## Fiber 依赖与源码沿革

`native/ai-server/` 由本仓库维护和构建，迁移来源记录在
[`native/ai-server/UPSTREAM.md`](native/ai-server/UPSTREAM.md)。构建只从固定的
`fiber-gateway-cpp` revision 引入可复用的 runtime 与基础设施模块，不构建或导入上游
`apps/ai-server` 源码。集成使用 Fiber 正式支持的 `FIBER_BUILD_NACOS`、
`FIBER_BUILD_CAT` 和 `FIBER_BUILD_PROMETHEUS` 组件开关，当前不再需要本地兼容补丁。

被忽略的上游副本仍可用于源码研究：

```bash
git -C .temp/fiber-gateway-cpp pull --ff-only
```

上游仓库：<https://github.com/fiber-net-gateway/fiber-gateway-cpp>
