# ai-server 调用审计上报与个人调用记录详细设计

## 1. 设计摘要

本设计实现需求文档 `docs/llm-call-audit-requirements.md` 的 P0。新增独立的
`llm-call-audit` 领域模块，不复用控制面 `audit_events` 表：

```text
ai-server 后台发送器（后续）
        │ Bearer + batch envelope
        ▼
POST /api/internal/llm-call-audits/batches
        │ 认证 → schema 校验 → 白名单投影 → 用户固化 → 幂等追加
        ▼
llm_call_audits（不含 request/response/attempts 原文）
        │ owner_user_id + environment_id + cursor
        ▼
GET /api/me/llm-call-audits
        │
        ▼
“我的调用记录”页面
```

平台操作审计继续使用 `audit_events` 和 `/api/admin/audit-events`。两类记录用途、权限和
敏感性不同，避免用一个宽泛 payload 表混装高吞吐调用历史。

## 2. 模块结构

```text
server/src/modules/llm-call-audit/
├── types.ts          # 上报投影、持久化记录、查询与 Store 接口
├── schemas.ts        # Fastify body/query JSON Schema
├── projection.ts     # v5 原始对象到白名单字段的纯函数
├── service.ts        # 认证后的接收编排、用户固化、cursor 与查询授权
├── memory-store.ts   # preview 和单元测试
├── mysql-store.ts    # 参数化单表 SQL
├── routes.ts         # internal ingest 和 /api/me 查询
└── llm-call-audit.test.ts

server/src/database/migrations/006-llm-call-audit.ts
web/src/pages/MyLlmCallsPage.tsx
```

`app.ts` 只组装依赖；`index.ts` 在 MySQL 模式创建 MySQL store。模块不在构造期间连接外部服务。

## 3. 配置

`AppConfig` 新增：

```ts
interface AuditIngestConfig {
  token: string
  bodyLimitBytes: number
}
```

| 环境变量                        |    默认值 | 规则                                       |
| ------------------------------- | --------: | ------------------------------------------ |
| `AUDIT_INGEST_TOKEN`            |        空 | 空表示入口关闭；生产使用至少 32 字节随机值 |
| `AUDIT_INGEST_BODY_LIMIT_BYTES` | `8388608` | 64 KiB 到 32 MiB                           |

token 不输出到配置 API，不写数据库。认证时先对期望值和请求值分别做 SHA-256，再对固定 32 字节
摘要使用 `timingSafeEqual`。入口关闭返回 503；缺失或错误凭据统一返回 401 和
`AUDIT_INGEST_UNAUTHORIZED`。

## 4. HTTP API

### 4.1 批量接收

```http
POST /api/internal/llm-call-audits/batches
Authorization: Bearer <token>
Content-Type: application/json
```

body 使用需求文档第 6 节信封。信封 `additionalProperties=false`，`audit` 允许上游附带其他
v5 字段，但以下字段必须存在并满足约束：

```ts
interface V5AuditInput {
  schema_version: 5
  event: 'llm_request'
  request_id: string
  auth_user: string
  requested_model: string
  client_protocol: string
  method: string
  path: string
  stream: boolean
  status: number
  duration_ms: number
  usage_json: {
    promptTokens: number
    completionTokens: number
    total_tokens: number
  }
  client_aborted?: boolean
  error_json?: string
  capture_complete?: boolean
  message_count?: number
  tool_count?: number
  request_body_bytes?: number
  response_body_bytes?: number
}
```

成功响应：

```json
{
  "accepted": 12,
  "duplicates": 3
}
```

状态为 202。Schema/字段问题由统一错误处理返回 400；认证 401；入口关闭 503；body 超限 413；
存储失败 500。route 不记录 body，也不把校验值放进错误详情。

### 4.2 个人查询

```http
GET /api/me/llm-call-audits?environmentId=<uuid>&limit=25&cursor=<opaque>
```

可选参数：

- `from`、`to`：ISO 8601 UTC 时间；
- `outcome`：`SUCCEEDED | FAILED | ABORTED`；
- `protocol`：最长 32 字符；
- `search`：最长 128 字符，匹配 request ID、path、requested model。

响应：

```ts
interface LlmCallAuditPage {
  items: LlmCallAuditView[]
  nextCursor: string | null
}
```

route 先用 Session 取得 actor，再用 `listEnvironmentsForUser` 确认 actor 对 `environmentId` 有访问权。
Service 始终把 `ownerUserId=actor.user.id` 传给 store，不接受客户端 owner/username。响应设置
`Cache-Control: no-store, private`。

## 5. 白名单投影

`projectV5Audit` 是无 I/O 纯函数，输入经过 schema 校验的逐条信封，输出
`NewLlmCallAuditRecord`。它执行：

1. `eventKey = SHA-256(environmentId + NUL + instanceId + NUL + requestId)`；
2. 复制并截断白名单字符串；
3. 从 `client_aborted`、status 和 `error_json` 计算 outcome；
4. 复制非负安全整数用量与尺寸；
5. 只保留最多 256 字符的 `error_json` 作为诊断标识；
6. 不展开或复制 `request_json`、`response_json`、`attempts_json` 等字段。

投影类型根本不声明禁止字段，store 接口无法意外接收原始 body。单元测试在输入中放入唯一 secret
marker，并断言序列化投影和查询响应均不存在 marker。

## 6. 用户固化

Service 对一批中不同的 `auth_user` 去重，调用 `UserStore.getUserByUsername`，构建
`Map<string, userId | null>`。投影行同时写：

- `owner_user_id`：接收时匹配到的稳定用户 ID，未匹配为 null；
- `subject_username`：审计 username 快照，仅用于诊断，不作为查询授权条件。

查询只使用 `owner_user_id`。不在读取时按 username 回填，避免新建同名账户继承旧记录。

## 7. 数据模型

新增 `llm_call_audits`：

```sql
CREATE TABLE llm_call_audits (
  id BINARY(16) NOT NULL,
  event_key BINARY(32) NOT NULL,
  environment_id BINARY(16) NOT NULL,
  owner_user_id BINARY(16) NULL,
  subject_username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_request_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_schema_version SMALLINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  received_at DATETIME(6) NOT NULL,
  method VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_path VARCHAR(2048) NOT NULL,
  requested_model VARCHAR(255) NOT NULL,
  client_protocol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_stream BOOLEAN NOT NULL,
  response_status SMALLINT UNSIGNED NOT NULL,
  outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  duration_ms BIGINT UNSIGNED NOT NULL,
  prompt_tokens BIGINT UNSIGNED NOT NULL,
  completion_tokens BIGINT UNSIGNED NOT NULL,
  total_tokens BIGINT UNSIGNED NOT NULL,
  client_aborted BOOLEAN NOT NULL,
  capture_complete BOOLEAN NOT NULL,
  message_count INT UNSIGNED NOT NULL,
  tool_count INT UNSIGNED NOT NULL,
  request_body_bytes BIGINT UNSIGNED NOT NULL,
  response_body_bytes BIGINT UNSIGNED NOT NULL,
  error_code VARCHAR(256) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_llm_call_audit_event (environment_id, event_key),
  KEY idx_llm_call_audit_owner_page
    (environment_id, owner_user_id, occurred_at DESC, id DESC),
  KEY idx_llm_call_audit_received (received_at, id),
  CONSTRAINT fk_llm_call_audit_environment
    FOREIGN KEY (environment_id) REFERENCES environments (id),
  CONSTRAINT fk_llm_call_audit_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

`event_key` 是固定长度唯一键，避免把最长 1024 字节 request ID 加进复合唯一索引。
`owner_user_id` 允许 null 以安全容纳暂未在 console 建档的 ai-server 用户。

## 8. Store 接口与 SQL

```ts
interface LlmCallAuditStore {
  appendBatch(records: NewLlmCallAuditRecord[]): Promise<{
    accepted: number
    duplicates: number
  }>
  listForOwner(query: LlmCallAuditListQuery): Promise<LlmCallAuditRecord[]>
}
```

MySQL `appendBatch` 在一个事务内按稳定顺序执行参数化单表 `INSERT`。唯一键冲突捕获为 duplicate；
其他错误回滚整批。已存在行不更新，保证 first-write-wins。

查询使用单表 SELECT：

```sql
SELECT ... FROM llm_call_audits
WHERE environment_id = UUID_TO_BIN(?)
  AND owner_user_id = UUID_TO_BIN(?)
  AND (occurred_at < ? OR (occurred_at = ? AND id < UUID_TO_BIN(?)))
ORDER BY occurred_at DESC, id DESC
LIMIT ?
```

其他筛选按需追加参数化谓词。关键字中的 `%`、`_` 和 `=` 先转义，再以 `LIKE ... ESCAPE '='`
查询。
不使用 JOIN、子查询、CTE、UNION、窗口函数或 COUNT。Service 请求 `limit + 1`，裁掉额外行并生成
next cursor。

## 9. Cursor

cursor 内容为：

```ts
{
  occurredAt: string
  id: string
}
```

以 JSON 编码后 base64url 返回。解码时校验对象形状、合法 UTC 时间和 UUID；错误返回
`INVALID_CURSOR` 400。cursor 不承载身份或环境，所有授权约束由服务端重新加入，因此篡改 cursor
不能扩大读取范围。

## 10. 前端设计

### 10.1 路由与导航

- `Section` 增加 `calls`；hash 为 `#/calls`。
- “个人工作台”在 Token 与权限申请之间增加“我的调用记录”。
- 非管理员允许访问 `models | tokens | calls | my-access`。
- 管理员原有 `audit` 仍位于“平台管理”。

### 10.2 页面状态

`MyLlmCallsPage` 接收 `environmentId` 和 `onError`，维护：

- `items`、`nextCursor`、`loading`、`loadingMore`；
- `searchInput` 与提交后的 `search`，避免每个按键都请求；
- `outcome`、`protocol`；
- 一个递增 request generation，忽略筛选切换前返回的旧响应。

首屏/筛选失败保留现有数据并通过全局 toast 提示；“加载更多”失败不清空列表。筛选提交或选择变化
时清空 cursor 并加载第一页。重复 ID 在前端合并，防御快速点击或重试响应。

### 10.3 展示

桌面表格列：

1. 调用时间与 request ID；
2. method + path；
3. requested model；
4. protocol + 流式/非流式；
5. outcome + HTTP status；
6. duration；
7. prompt/completion/total tokens。

不展示 username、instance、errorCode 或任意原始正文。空状态文案为“尚未收到 ai-server 上报的
调用记录”，筛选后空状态为“暂无匹配记录”。表格外层沿用 `table-wrap` 允许窄屏横向滚动。

## 11. 错误码

| 错误码                      | HTTP | 场景                      |
| --------------------------- | ---: | ------------------------- |
| `AUDIT_INGEST_DISABLED`     |  503 | 未配置上报 token          |
| `AUDIT_INGEST_UNAUTHORIZED` |  401 | Bearer 缺失或不匹配       |
| `VALIDATION_FAILED`         |  400 | 信封或 v5 字段不合法      |
| `ENVIRONMENT_NOT_FOUND`     |  404 | 当前用户无目标环境访问权  |
| `INVALID_CURSOR`            |  400 | cursor 无法解码或字段非法 |
| `INVALID_TIME_RANGE`        |  422 | from 晚于 to              |

内部错误沿用 `INTERNAL_ERROR`，不包含 body、token 或数据库参数。

## 12. 生命周期与故障语义

- memory store 随进程退出清空；页面不得暗示持久化。
- MySQL store 与现有连接池共用生命周期，在 `index.ts` migration 后构造。
- HTTP 202 只证明 console 已持久化该投影，不证明原始文件已删除，也不证明配置或实例状态。
- console 失败时 ai-server 发送器应按有界退避重试；达到队列上限的丢弃策略和指标由 ai-server
  后续设计决定，不能阻塞或改变用户的 LLM 响应。
- console 不保存发送进度，不反向读取 ai-server 文件；文件回补属于后续采集能力。

## 13. 测试设计

后端至少覆盖：

- 认证关闭、无效 Bearer 和有效 Bearer；
- v5 投影、outcome、usage、时间和默认可选字段；
- 同批重复与跨请求重放；
- Alice/管理员/未知用户归属隔离；
- 原始 request/response/attempts/secret marker 未进入 store/API；
- cursor、limit、筛选、排序和非法时间范围；
- MySQL store 源码静态禁止 JOIN、子查询、COUNT、UNION 和 INSERT SELECT。

前端当前没有测试框架，执行类型检查与生产构建，并手工验证桌面/移动、键盘筛选、加载更多、空态和
错误 toast。最终运行：

```bash
npm run typecheck && npm test && npm run format:check && npm run build
```

## 14. 后续 ai-server 对接约束

本仓库只定义接收契约。ai-server 发送器实现时必须：

- 在现有审计记录生成完成后，把发送任务放入独立有界队列；
- 不在请求 worker 上等待 console；
- 保留现有文件审计，HTTP 上报首版不能成为唯一副本；
- 用稳定 instance ID 和原 request ID 重试，不能每次生成新幂等身份；
- 给每条记录附加生成时 `occurredAt`；
- 对 202 停止重试，对 401/400 进入告警或死信，对 429/5xx 使用有界指数退避；
- 日志和指标禁止打印 Bearer、原始 request/response 或响应错误 body。
