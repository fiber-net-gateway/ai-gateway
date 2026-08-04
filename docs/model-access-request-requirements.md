# 模型调用权限申请详细需求

## 1. 文档信息

| 项目           | 内容                                                                  |
| -------------- | --------------------------------------------------------------------- |
| 所属产品       | Fiber AI Server Console                                               |
| 上位需求       | `docs/product-requirements.md`                                        |
| 关联需求       | `docs/model-marketplace-requirements.md`                              |
| 关联设计       | `docs/model-access-request-design.md`                                 |
| 模块           | 模型调用权限申请、管理员审批、模型授权组、rnacos 发布                 |
| 文档状态       | 需求基线                                                              |
| 编写日期       | 2026-08-03                                                            |
| ai-server 基线 | `fiber-gateway-cpp` commit `fb48494dfbf99d77806674fc182007e22e19b081` |
| 固定配置组     | `LLM-SERVER`                                                          |

本文细化普通用户申请模型调用权限、管理员审批，以及审批后把用户加入授权组的完整
流程。它是实现和验收基线，不把 MySQL、rnacos 与 ai-server 运行实例三类事实混为一谈。

## 2. 背景与上游约束

ai-server 先根据逻辑模型的 `allow-user-groups` 完成授权，再选择主 Provider、Token 和
Fallback。相关上游依据为：

| 契约                               | 上游路径                                             |
| ---------------------------------- | ---------------------------------------------------- |
| 用户组 Data ID、快照和模型引用     | `apps/ai-server/src/config/LlmConfigSnapshot.h`      |
| 用户组、models JSON 字段与名称校验 | `apps/ai-server/src/config/LlmConfigCodec.cpp`       |
| 模型授权时任一用户组命中即放行     | `apps/ai-server/src/routing/ModelAuthorization.cpp`  |
| 授权早于 Provider 执行计划         | `apps/ai-server/docs/architecture.md`                |
| 控制台配置与状态边界               | `apps/ai-server/docs/config-console-requirements.md` |

因此本模块采用以下严格术语：

- 用户申请的是一个逻辑模型的调用权限，不是某次请求固定命中某个 Provider 的权限。
- 每个需要审批的逻辑模型拥有一个独立“申请授权组”，组 identity 不依附于 Provider。
- 用户进入该组后只获得该逻辑模型的权限；请求仍可能命中模型配置的任意主 Provider 或
  Fallback。
- 当前 ai-server 不支持“授权后只允许路由到指定 Provider”。产品不得展示这种虚假承诺。

用户组配置固定使用：

```text
group   = LLM-SERVER
dataId  = ploto.ai-llm.user-group.<group-name>
content = {"version":N,"data":{"name":"<group-name>","users":[...]}}
```

`group-name` 必须为 1..64 字节，只允许 ASCII 字母、数字、下划线和连字符；`users`
使用 ai-server 认证后的精确 username，排序、去重后输出。

## 3. 目标与非目标

### 3.1 目标

- 普通用户在模型广场看到本人是否可调用、能否申请及最近申请状态。
- 普通用户填写用途说明后提交申请，同一用户、环境和模型只允许一个待审批申请。
- 管理员查看待审批队列、申请人、模型和模型授权组。
- 管理员批准或拒绝；申请人不能审批自己的申请。
- 批准时把申请人的精确 username 加入模型自己的申请授权组，并创建不可变发布记录。
- 发布器只写固定的用户组 Data ID，写后回读并校验 MD5；失败可以安全重试。
- 全流程写审计事件，并把审批、发布和实例生效状态分别展示。
- 普通用户永远看不到其他组成员、Provider 地址、Provider Token 或管理员备注以外的内部信息。

### 3.2 非目标

- 不建设通用用户组编辑器，不允许浏览器传入任意 Data ID 或 group。
- 不允许申请人选择 Provider、用户组名称或 rnacos 目标。
- 不实现 Provider 级请求隔离、模型套餐、计费、自动续期或按 Token 配额审批。
- 首版不实现权限到期和自动移除；已批准授权的撤销作为后续独立高风险流程。
- 不把审批通过或 rnacos 回读成功显示为 ai-server 实例已生效。
- 不调用 ai-server 的 LLM 路由验证权限，也不由控制台代理一条测试对话。

## 4. 角色与权限

| 能力                             | 普通用户 `USER` | 管理员 `ADMIN` |
| -------------------------------- | --------------- | -------------- |
| 查看本人已分配环境的模型目录     | 是              | 是             |
| 查看本人是否可调用和本人申请状态 | 是              | 是             |
| 提交模型权限申请                 | 是              | 是             |
| 取消本人待审批申请               | 是              | 是             |
| 查看全部申请及影响范围           | 否              | 是             |
| 批准、拒绝、重试组发布           | 否              | 是             |
| 查看其他组成员                   | 否              | 仅审批影响摘要 |
| 回读其他用户的申请用途           | 否              | 是             |

约束：

- 所有权限必须由 API 校验；前端隐藏按钮不构成授权。
- 申请人和审批人必须不同，即使申请人是管理员也不能自批。
- 用户必须仍为 `ACTIVE` 且仍拥有目标环境访问权，管理员才能批准。
- 模型、申请授权组和用户必须属于同一环境。
- 生产环境审批写入 rnacos 前应要求五分钟内完成二次认证；当前开发登录会话可满足本地验证，
  OIDC 环境依据会话中的 MFA 时间判定。

## 5. 模型访问模式与模型授权组

### 5.1 访问模式

模型编辑器提供两个明确选项：

| 模式                | models 配置                      | 普通用户行为               |
| ------------------- | -------------------------------- | -------------------------- |
| `ALL_AUTHENTICATED` | `allow-user-groups: []`          | 已认证且有环境访问即可调用 |
| `APPROVAL_REQUIRED` | 仅引用一个控制台管理的申请授权组 | 非成员可见模型并可提交申请 |

从 `ALL_AUTHENTICATED` 切换到 `APPROVAL_REQUIRED` 时，后端按不可变 model ID 幂等创建
模型授权组，并把该组写入模型草稿。组 identity 与模型保持稳定，不因 Provider 绑定、展示名
或排序变化而迁移。

从 `APPROVAL_REQUIRED` 切换为 `ALL_AUTHENTICATED` 会扩大访问范围，必须在 UI 展示风险；
历史组和成员不删除，但模型草稿不再引用该组。只有 models Data ID 发布并被实例接受后，
新范围才可能实际生效。

### 5.2 组归属与名称

一个模型在一个环境内最多有一个申请授权组，不与其他模型复用。组名由服务端根据 model ID
和逻辑模型名生成，格式为 `ma_<prefix>_<digest>`；客户端不能指定、修改或复用名称。组名在
创建后永久稳定。

## 6. 用户流程

### 6.1 提交申请

普通用户在模型卡片或详情页看到以下互斥状态：

- `可调用`：模型面向全部用户，或申请授权组的最新发布内容已包含本人。
- `可申请`：模型要求审批、组已正确绑定，且本人没有待审批/已批准申请。
- `待审批`：已有待审批申请，可进入“我的申请”查看或取消。
- `已批准，待发布`：审批已完成，组期望成员已更新，但 rnacos 未完成回读校验。
- `已发布，生效未知`：rnacos 内容已校验，本人静态上应可调用，但没有实例接受证据。
- `发布失败`：审批仍有效，管理员需要重试发布。
- `不可申请`：模型配置不完整、没有模型申请组、模型已归档或环境访问已撤销。

申请表单字段：

| 字段     | 规则                                                         |
| -------- | ------------------------------------------------------------ |
| 申请模型 | 只读，使用不可变 model ID 提交                               |
| 用途说明 | 必填，10..500 字符；禁止控制字符；不得包含 BT1/Provider 密钥 |

提交前必须再次读取已发布版本。以下情况返回稳定错误：模型不存在、模型对全部用户开放、本人已是
已发布成员、模型没有申请授权组、已有待审批申请或已有批准申请。

提交成功返回 `201`；相同 `Idempotency-Key` 和相同请求重放返回 `200`，不同请求复用该键返回
`409 IDEMPOTENCY_CONFLICT`。

### 6.2 取消申请

申请人只能取消 `PENDING` 申请。取消后状态为 `CANCELLED`，保留历史和审计；管理员若与取消
并发，数据库行锁和 revision 保证只有一个状态转换成功。批准后的申请不能通过取消撤回。

### 6.3 管理员审批

审批页默认展示 `PENDING`，支持按环境、状态和关键词筛选。每项至少显示：

- 申请人显示名和 username；
- 逻辑模型名和展示名；
- 用途说明、提交时间和等待时长；
- 目标模型和模型授权组名；
- 当前审批、发布和生效三层状态。

批准可填写 0..500 字符备注；拒绝必须填写 1..500 字符原因。批准动作的业务事务顺序为：

1. 锁定并重新验证申请仍为 `PENDING`。
2. 重新验证申请人、环境、模型和授权组归属关系。
3. 增加组 revision，幂等加入组成员；已存在时不产生重复行。
4. 按完整成员集合生成确定性内容。
5. 创建不可变发布记录，状态为 `PENDING`。
6. 把申请状态改为 `APPROVED`，提交事务。
7. 事务提交后调用 rnacos 发布器并回写结果。

拒绝不修改组成员、不创建发布记录。

## 7. 三层状态与失败语义

### 7.1 状态来源

| 层                 | 状态                                                     | 事实来源                       |
| ------------------ | -------------------------------------------------------- | ------------------------------ |
| 审批/期望成员      | `PENDING`、`APPROVED`、`REJECTED`、`CANCELLED`           | MySQL 申请与成员记录           |
| rnacos 发布        | `NOT_STARTED`、`PENDING`、`PUBLISHED`、`FAILED`          | 不可变发布记录、写入和回读 MD5 |
| ai-server 实例生效 | `UNKNOWN`、`PENDING`、`EFFECTIVE`、`PARTIAL`、`REJECTED` | 逐实例明确接受证据             |

严格文案：

- “审批通过”只表示 MySQL 中已经形成期望组成员和不可变发布任务。
- “已发布”只表示目标 Data ID 写入成功且回读内容 MD5 与目标一致。
- “已生效”必须由 ai-server 实例报告接受了包含该用户组版本的完整快照。
- 当前实例状态接口不能证明具体用户组版本时，始终显示“生效未知”。

### 7.2 发布失败

发布失败不回滚审批或成员期望，因为 rnacos 写入结果可能不确定，回滚数据库会制造另一种
不一致。系统记录安全错误码和安全摘要，不记录 rnacos 密码、access token 或完整响应正文。
管理员可点击重试；重试复用同一不可变目标内容，创建新的发布 attempt，不重新审批。

若发布写入成功但回读不一致，状态为 `FAILED`，错误码 `RNACOS_READBACK_MISMATCH`。页面必须
提示可能存在并发外部写入，不得显示部分生效或已发布。

## 8. API 需求

所有接口位于 `/api`，使用会话认证；写接口校验 CSRF。ID 均为 UUID，时间为 UTC ISO 8601。

### 8.1 普通用户

```text
GET    /api/me/model-access-requests?environmentId=&status=&cursor=&limit=
POST   /api/environments/:env/models/:modelId/access-requests
POST   /api/me/model-access-requests/:requestId/cancel
```

创建请求：

```json
{
  "reason": "用于团队内部知识库问答和文档摘要"
}
```

普通用户响应不得包含组成员列表、Provider Base URL、Token 摘要、rnacos 凭据或审批人的内部
安全信息。可以返回目标组的公开管理名称，但默认只显示“模型申请授权组”。

### 8.2 管理员

```text
GET  /api/admin/model-access-requests?environmentId=&status=&search=&cursor=&limit=
POST /api/admin/model-access-requests/:requestId/approve
POST /api/admin/model-access-requests/:requestId/reject
POST /api/admin/model-access-requests/:requestId/retry-publication
```

批准与拒绝携带 `If-Match` 申请 revision。冲突返回 `412 REQUEST_REVISION_CONFLICT`，并返回当前
revision。管理员列表使用 `LIMIT pageSize + 1` cursor 分页，不执行 `COUNT(*)`。

错误响应沿用项目稳定结构：`code`、`message`、`retryable`、`correlationId`、字段路径和安全
details。不得把 SQL、外部响应正文或凭据写入响应。

## 9. 审计要求

至少记录：

| 事件                                       | 关键安全字段                                  |
| ------------------------------------------ | --------------------------------------------- |
| `model_access.request.created`             | requestId、modelId、groupId、reasonLength     |
| `model_access.request.cancelled`           | requestId、modelId                            |
| `model_access.request.approved`            | requestId、modelId、groupId、publicationId    |
| `model_access.request.rejected`            | requestId、modelId、decisionReason            |
| `model_access.group.publication_succeeded` | publicationId、dataId、targetMd5、readbackMd5 |
| `model_access.group.publication_failed`    | publicationId、dataId、safeErrorCode          |

申请理由和拒绝原因属于业务审计内容，可以保存；日志不得打印完整请求 body。组成员只记录本次变更
username，不在审计 payload 中复制完整成员集合。

## 10. 非功能要求

- 申请和审批 API 的 P95（不含外部发布）应低于 300 ms；rnacos 发布最多等待 10 秒。
- rnacos 超时不阻塞数据库事务，不使审批回滚。
- 所有运行时 SQL 严格参数化且每条只访问一张物理表；跨表关系在 TypeScript 组装。
- 列表采用稳定 cursor，不使用 OFFSET 或跨表 COUNT。
- 单元测试不依赖 live MySQL、rnacos、ai-server、真实时钟或公网。
- 模型授权组内容按 username byte order 排序，重复批准不产生重复成员或非确定性 JSON。
- 所有按钮支持键盘操作；状态使用文字和图标，不只依赖颜色。
- 移动端审批卡片按申请、审批、发布、生效顺序纵向展示。

## 11. 验收标准

1. 管理员可把模型设置为“需要审批”；草稿显示模型授权组，发布前不宣称已生效。
2. 普通用户对受限已发布模型提交用途说明，重复待审批申请被阻止。
3. 普通用户不能读取其他用户的申请或组成员。
4. Provider 绑定发生变化时，模型授权组和已有申请关系保持稳定。
5. 申请人不能自批；非管理员不能调用审批接口。
6. 批准后 MySQL 申请为 `APPROVED`、成员期望已加入、发布记录已创建，三者可审计。
7. rnacos 写入及回读一致后只显示“已发布，生效未知”，不会显示“已生效”。
8. rnacos 失败后批准事实不丢失，管理员可重试同一不可变内容。
9. 拒绝和取消都不修改组成员或发布 rnacos。
10. 模型开放给所有用户时不出现申请按钮，提交 API 返回稳定冲突错误。
11. Provider Token、BT1、MySQL/rnacos 凭据不出现在响应、日志、差异或审计 payload。
12. `npm run typecheck && npm test && npm run format:check && npm run build` 全部通过。
