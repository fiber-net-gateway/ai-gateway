# ai-server 调用审计上报与个人调用记录需求

## 1. 文档信息

| 项目     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 产品     | ai-server 管理控制台                                         |
| 能力     | ai-server 审计日志 HTTP 上报、核心字段提取、个人调用记录查询 |
| 需求状态 | P0 实施基线                                                  |
| 上游基线 | `fiber-gateway-cpp/apps/ai-server` audit `schema_version=5`  |
| 关联模块 | 用户与会话、环境、BT1、平台操作审计                          |

本文档细化 ai-server 调用审计进入 console 后的产品目标和验收边界。它不改变现有平台
操作审计，也不代表 ai-server 已具备 HTTP 上报能力；ai-server 侧异步发送器是后续独立工作。

## 2. 背景与问题

ai-server 当前把每次 LLM 请求生成成一条 `schema_version=5` 的纯 JSON 审计记录，并通过
独立的异步日志链路写入 NDJSON 文件。文件能用于离线采集，但 console 无法直接回答普通用户：

- 我在什么时间调用过哪个接口和模型；
- 请求使用了哪种协议、是否流式；
- 请求是否成功、耗时多久、消耗了多少 Token；
- 某个客户端 request ID 对应哪次调用。

同时，ai-server 的原始审计记录含完整 `request_json`、`response_json`、Provider attempts、
来源 IP 和 User-Agent。请求和响应正文可能含业务秘密，Provider attempts 还含内部路由信息，
不应原样复制到面向用户的 console 数据库和 API。

## 3. 目标

P0 必须完成：

1. console 后端提供仅供受信 ai-server 使用的批量 HTTP 上报入口。
2. 上报入口兼容 ai-server 当前 `schema_version=5`、`event=llm_request` 的扁平审计对象。
3. console 从原始对象提取白名单字段，并在持久化前丢弃原始请求、响应和内部路由数据。
4. 上报支持至少一次投递：同一实例、同一环境、同一 request ID 重试不会产生重复记录。
5. 登录用户只能分页查询自己在已授权环境中的调用记录。
6. 前端提供“我的调用记录”页面，覆盖加载、空状态、失败、筛选和继续加载。
7. memory 模式无需外部服务即可演示和测试；MySQL 模式使用确定性迁移持久化。

## 4. 非目标

P0 不包含：

- 修改 ai-server、实现其 HTTP 队列、重试、熔断或文件回补；
- 代理在线 LLM 流量，或让 console 参与 ai-server 请求成功与否的判定；
- 保存或展示 prompt、模型回复、tool arguments、完整 Provider attempts；
- 把上报成功解释为配置已发布或 ai-server 实例已接受某份配置；
- 管理员跨用户检索对话正文、导出调用明细或修改/删除单条记录；
- 根据 `auth_kid` 猜测具体 BT1 Token，或在证据不足时更新 Token 的 `last_used_at`；
- P0 自动归档和清理。保留期、合规导出和分区策略在数据量基线明确后另行设计。

## 5. 角色与权限

| 动作                 | ai-server 上报方 | 普通用户 |   管理员 |
| -------------------- | ---------------: | -------: | -------: |
| 批量提交调用审计     |     受信凭据允许 |       否 |       否 |
| 查看自己的调用记录   |               否 |       是 |       是 |
| 查看其他用户调用记录 |               否 |       否 | 否（P0） |
| 查看平台操作审计     |               否 |       否 |       是 |
| 修改或删除调用记录   |               否 |       否 |       否 |

管理员在“我的调用记录”中与普通用户遵循相同的归属约束。原有“审计事件”页面仍是控制面
操作审计，两者在导航、标题、API 和数据表上均保持分离。

## 6. 上游输入契约

### 6.1 批量信封

ai-server 后续发送器按以下信封调用 console：

```json
{
  "schemaVersion": 1,
  "instanceId": "ai-server-daily1-dev-01",
  "sentAt": "2026-08-04T08:00:03.000Z",
  "records": [
    {
      "occurredAt": "2026-08-04T08:00:02.431Z",
      "audit": {
        "schema_version": 5,
        "event": "llm_request",
        "request_id": "4ab7-22cd",
        "auth_user": "alice",
        "requested_model": "claude-sonnet",
        "client_protocol": "anthropic",
        "method": "POST",
        "path": "/v1/messages",
        "stream": true,
        "status": 200,
        "duration_ms": 842,
        "usage_json": {
          "promptTokens": 120,
          "completionTokens": 48,
          "total_tokens": 168
        }
      }
    }
  ]
}
```

`occurredAt` 是 ai-server 完成该请求并生成审计记录时的 UTC 时间。当前文件记录本身没有可靠的
调用时间字段，因此 HTTP 发送器必须在信封中显式提供，console 不用接收时间替代调用时间。

### 6.2 限制

- 每批 1 到 100 条；HTTP body 最大 8 MiB。
- `instanceId` 1 到 128 个 ASCII 字符，在一个环境内稳定标识进程实例。
- `request_id`、`auth_user` 和核心展示字段必须通过长度、类型与数值范围校验。
- 只接受 `schema_version=5` 和 `event=llm_request`。不认识的 schema 必须显式拒绝，不能静默误解。
- `sentAt` 用于诊断发送延迟；P0 不持久化它，也不据此覆盖逐条 `occurredAt`。
- 上报凭据绑定 console 当前配置环境，客户端不能通过 body 任意选择环境。

## 7. 身份归属

console 使用审计记录的 `auth_user` 精确查找 console 用户，并在接收时固化 `owner_user_id`：

- 匹配到用户：记录可由该用户在相同环境下查询；
- 未匹配到用户：记录仍可幂等接收，但 `owner_user_id` 为空，不会因未来新建同名用户而自动可见；
- 用户后续改显示名称不影响归属；P0 不允许修改 username，软删除也不复用 username；
- 查询必须同时约束 `owner_user_id` 和 `environment_id`，不能仅相信浏览器传入 username。

该规则避免“先收到未知 username 的记录，后创建同名用户却看到历史他人数据”的身份串用。

## 8. 数据最小化

### 8.1 允许持久化的白名单

| 类别 | 字段                                                                   |
| ---- | ---------------------------------------------------------------------- |
| 来源 | 环境、实例 ID、源 request ID、源 schema 版本                           |
| 归属 | owner user ID、username 快照                                           |
| 时间 | occurred at、console received at                                       |
| 接口 | method、path、requested model、client protocol、stream                 |
| 结果 | response status、成功/失败/客户端中断、duration、client aborted        |
| 用量 | prompt、completion、total tokens                                       |
| 摘要 | message/tool 数、请求/响应字节、capture complete、安全截断后的错误标识 |

### 8.2 禁止持久化或返回

- `request_json`、`response_json`、`tool_arguments`、`tool_names`；
- `attempts_json`、`rate_limit_json`、resolved Provider/model、Provider token 名称或摘要；
- `remote_addr`、`real_ip`、`user_agent`、`host`；
- Authorization、BT1 明文或签名、Provider Token、MySQL/rnacos/上报凭据；
- 未在白名单中的任意原始字段。

后端不得把接收 body 写入应用日志、错误详情或平台操作审计 payload。原始对象只在请求解析和
白名单投影期间短暂存在，不进入 store 接口。

## 9. 上报认证、幂等与确认

- 使用 `Authorization: Bearer <AUDIT_INGEST_TOKEN>`，与浏览器 Session/CSRF 完全分离。
- 未配置 token 时入口返回 `AUDIT_INGEST_DISABLED`，不能以开发登录或管理员身份替代。
- token 至少使用 32 字节随机值，通过环境变量注入，不写数据库、不回显、不记录日志。
- 服务端使用恒定长度摘要做 timing-safe 比较；无效凭据统一返回 401，不泄露配置状态。
- 幂等键为 `SHA-256(environmentId + NUL + instanceId + NUL + requestId)`。
- 相同幂等键首次内容为准；重试只计为 duplicate，不覆盖已有记录。
- console 只有在数据库提交成功后才返回 `202 Accepted`。这里的异步指 ai-server 不阻塞其用户
  请求路径，由后台发送；不是 console 在未持久化时提前确认。
- 返回 `accepted` 和 `duplicates` 数量。批内任意存储错误使整批失败，ai-server 可安全重试。

## 10. 用户查询

接口为 `GET /api/me/llm-call-audits`，要求有效登录会话和环境访问权。支持：

- 必填 `environmentId`；
- `limit` 1 到 100，默认 25；
- 基于 `(occurredAt, id)` 的不透明 cursor，使用 `LIMIT pageSize + 1`；
- 可选时间范围、结果状态、协议和关键字；关键字匹配 request ID、path 或 requested model；
- 按 `occurredAt DESC, id DESC` 稳定排序；
- 响应只含白名单视图和 `nextCursor`，并设置 `Cache-Control: no-store, private`。

结果状态固定为：

- `SUCCEEDED`：客户端未中断、HTTP 2xx/3xx 且 `error_json` 为空；
- `FAILED`：不满足成功条件且不是客户端中断；
- `ABORTED`：`client_aborted=true`。

## 11. 前端交互

“个人工作台”新增“我的调用记录”，普通用户和管理员均可访问：

- 顶部说明这是 ai-server 已上报并被 console 接收的记录，不等于完整文件审计；
- 展示时间、method/path、requested model、协议/流式、结果、HTTP 状态、耗时和 Token 用量；
- 支持关键字、结果和协议筛选，筛选变化后从第一页重新加载；
- 有独立的首屏加载、加载更多、无记录、无匹配结果和失败提示；
- request ID 可见但不暴露 username、实例 ID 或内部路由；
- 移动端可横向滚动表格，筛选控件可换行，所有控件有可访问名称；
- 不以颜色作为成功/失败的唯一表达，状态徽标必须有文本。

如果尚未配置上报或 ai-server 尚未实现发送，页面显示“暂无上报记录”，不能显示“未调用过”。

## 12. 安全与运行要求

- 上报路由设置独立 body limit，Fastify schema 拒绝额外信封字段和非法核心类型。
- body、Bearer token 和原始审计字段不得进入日志；错误响应只含稳定错误码和 correlation ID。
- MySQL SQL 严格参数化且单表；不使用 JOIN、子查询、CTE、UNION、窗口函数或 `COUNT(*)`。
- 记录追加写；P0 无更新、单条删除和浏览器写入 API。
- 接收失败不影响 ai-server 已完成的 LLM 响应。ai-server 侧必须以后台有界队列实现，不能在请求
  worker 上同步等待 console。
- 监控至少应能从 HTTP 状态和计数识别接收、重复、鉴权失败、校验失败和存储失败；指标实现
  可随 ai-server 发送器工作一并补充。

## 13. 验收标准

1. 有效 Bearer token 可批量提交两个 v5 记录并得到 202 与准确计数。
2. 重放相同实例和 request ID 不新增行，返回 duplicate。
3. 无 token、错误 token、v4 schema、空批次和超限字段得到稳定 4xx/503 错误。
4. 上报中即使含 prompt、回复、tool arguments、Provider token marker 和 attempts，store/API
   响应与浏览器构建产物均不出现这些值。
5. `auth_user=alice` 的记录只对 Alice 可见；管理员和其他用户通过个人接口看不到 Alice 的记录。
6. 未匹配 console 用户的记录不会在之后创建同名用户时自动出现。
7. cursor 分页无重复、无遗漏，筛选不绕过 owner 和 environment 约束。
8. memory 与 MySQL store 语义一致；MySQL 源码通过单表 SQL 规则测试。
9. 前端桌面和移动布局可用，键盘可操作，空态明确说明“尚未收到上报”。
10. `npm run typecheck`、`npm test`、`npm run format:check` 和 `npm run build` 全部通过。

## 14. 上游依据

字段和语义以以下上游文件为准，ai-server HTTP 发送器落地时应再次核对：

- `apps/ai-server/src/server/LlmRequestHandler.cpp`：v5 字段编码、usage、duration、完成状态；
- `apps/ai-server/docs/rename_log_field.md`：扁平字段映射和 `error_json` 规则；
- `apps/ai-server/README.md`：纯 NDJSON、best-effort 投递、敏感正文与安全边界。
