# 模型广场详细需求

## 1. 文档信息

| 项目           | 内容                                                                  |
| -------------- | --------------------------------------------------------------------- |
| 所属产品       | Fiber AI Server Console                                               |
| 上位需求       | `docs/product-requirements.md`                                        |
| 关联设计       | `docs/model-marketplace-design.md`                                    |
| 模块           | 模型广场、模型供应商接入、协议映射、供应商 API Token                  |
| 文档状态       | 需求基线                                                              |
| 编写日期       | 2026-08-02                                                            |
| ai-server 基线 | `fiber-gateway-cpp` commit `fdd8f122394757231713416e3d9a281dd1e14def` |

本文细化“模型广场”功能。模型广场是控制台内的模型目录和配置入口，不是公开模型市场，也
不是聊天页面。管理员在这里维护逻辑模型、供应商接入、协议映射和供应商凭据，通过既有草稿、
审批、发布和实例生效确认流程交付给 ai-server；普通用户只查看自己可用的模型目录。

## 2. 背景与目标

目前 ai-server 的一个可调用模型由两类动态配置共同组成：

- `ploto.ai-llm.models` 定义客户端请求使用的逻辑模型名、主 Provider、Fallback、用户组和
  流量策略。
- `ploto.ai-llm.provider.<provider-name>` 定义供应商地址、API Token 池，以及每种协议对应的
  上游路径和上游模型名。

直接编辑这两类 JSON 容易混淆逻辑模型名、供应商模型名和 Provider 名，也容易在多 Data ID
发布时产生部分成功。模型广场需要把这些底层资源组织成一个可理解、可校验、可审计的业务
视图，同时不隐藏底层真实状态。

### 2.1 目标

- 以卡片和详情页集中展示一个环境内可调用的模型。
- 支持为模型配置一个或多个供应商接入，至少一个主供应商，可选 Fallback。
- 每个供应商接入可同时支持 OpenAI Chat Completions 和 Anthropic Messages。
- 每种协议独立配置供应商上游的 `model` 和请求路径。
- 每个供应商接入维护一组 API Token，支持安全新增、轮换和删除。
- 在保存和发布前完成字段、资源关系、全环境依赖图三层校验。
- 始终区分 MySQL 草稿、rnacos 已发布和 ai-server 实例已生效三种状态。
- 对普通用户提供安全、简洁的可用模型目录，不暴露供应商地址、Token 或管理草稿。

### 2.2 非目标

- 不在控制台内代理或转发用户的 LLM 请求。
- 不提供聊天、Prompt 调试、模型效果评测、计费结算或供应商采购能力。
- 不自动把 OpenAI 请求转换为 Anthropic 请求，反之亦然。
- 不在首版开放 `openai-embedding`；上游虽能解析该配置，但 ai-server 当前没有对应入站路由。
- 不以“rnacos 写入成功”推断全部 ai-server 实例已接受配置。
- 不承诺在线探测供应商 Token。首版只验证格式和配置关系，实际可用性来自 ai-server 运行
  状态和请求结果观测。
- 不允许浏览器或普通 API 回读任何供应商 Token 明文。

## 3. 术语与关键约束

### 3.1 术语

| 术语             | 含义                                                                |
| ---------------- | ------------------------------------------------------------------- |
| 广场模型         | 控制台聚合视图，包含模型展示信息、逻辑模型和供应商接入关系          |
| 逻辑模型名       | 客户端请求体中的 `model`，对应 `ploto.ai-llm.models[].model-name`   |
| 供应商接入       | ai-server Provider 资源，对应一个固定 Provider 名和一个 Data ID     |
| 供应商上游模型名 | Provider 协议项中的 `model`，ai-server 转发前会把请求模型改写为该值 |
| 协议映射         | Provider 下的 `type + path + model`                                 |
| 供应商 API Token | ai-server 调用上游供应商时使用的凭据，不是用户调用 ai-server 的 BT1 |
| 静态协议覆盖     | 仅根据模型与 Provider 配置推导出的理论可执行协议                    |
| 运行时可用       | 进一步考虑实例配置、Provider 熔断、Token 暂停和服务发现后的实际状态 |

### 3.2 名称不能混用

以下三个名字用途不同，界面、API、数据库和审计必须使用明确字段名：

| 界面名称         | API 字段            | rnacos 字段                   | 示例                   |
| ---------------- | ------------------- | ----------------------------- | ---------------------- |
| 逻辑模型名       | `logicalModelName`  | `model-name`                  | `chat-pro`             |
| Provider 标识    | `providerName`      | Data ID 后缀、`data.provider` | `mp_chat_pro_vendor_a` |
| 供应商上游模型名 | `upstreamModelName` | `data.protocol[].model`       | `vendor-chat-2026-07`  |

界面不得把 Provider 协议项中的 `model` 标为“逻辑模型名”。用户口述的“供应商
model-name”在产品中统一显示为“供应商上游模型名”。

### 3.3 协议执行语义

- OpenAI 入站请求只会选择包含 `openai-chat-completions` 映射的 Provider。
- Anthropic 入站请求只会选择包含 `anthropic-messages` 映射的 Provider。
- 同一个供应商接入可以同时包含两项，因此同一个逻辑模型可同时支持两种入口。
- 两项映射的上游模型名和路径可以不同；创建时可一键复制，保存后仍分别维护。
- ai-server 不做 OpenAI 与 Anthropic 的协议转换。只有供应商端点原生兼容相应协议时才可配置。
- 当前 ai-server 对两种协议的供应商凭据都发送 `Authorization: Bearer <token>`。仅接受
  `x-api-key` 等其他认证头的供应商在上游增加兼容层或 ai-server 扩展前不能直接接入。

## 4. 用户角色与权限

本模块沿用用户模块的两种系统角色：`USER` 和 `ADMIN`。所有权限必须由后端校验。

### 4.1 普通用户 `USER`

- 查看已分配环境中已发布的模型目录。
- 查看逻辑模型名、展示名称、说明、协议入口、本人是否有访问权限和可信的生效状态。
- 查看协议调用示例，但示例只能包含占位 BT1 Token。
- 不能查看草稿、供应商地址、Provider 标识、供应商 Token 名或数量、发布差异。
- 不能新增、编辑、归档、发布模型或发起供应商连接测试。
- 当本人不在模型允许的用户组中时，可看到“无访问权限”及申请指引，但不能看到其他组成员。

### 4.2 管理员 `ADMIN`

- 查看模型广场的管理视图、全部安全元数据和引用关系。
- 在环境级草稿中新增、编辑、复制、归档模型和供应商接入。
- 新增、替换、删除供应商 API Token，但永远不能回读已保存明文。
- 执行字段、关系和环境图校验，查看脱敏差异和发布影响。
- 按环境策略提交、审批、执行发布和回滚。
- 查看逐 Data ID 发布结果、逐实例生效结果、漂移和审计记录。

### 4.3 权限矩阵

| 功能                         | 普通用户 | 管理员 |
| ---------------------------- | -------- | ------ |
| 查看本人可用的已发布模型     | 是       | 是     |
| 查看管理草稿与脱敏差异       | 否       | 是     |
| 查看供应商地址和安全元数据   | 否       | 是     |
| 查看供应商 Token 明文        | 否       | 否     |
| 新增或修改模型               | 否       | 是     |
| 新增、替换或删除供应商 Token | 否       | 是     |
| 提交、审批、发布、回滚       | 否       | 按策略 |
| 查看完整审计                 | 否       | 是     |

## 5. 范围与信息架构

### 5.1 导航

```text
环境选择器
└── 模型广场
    ├── 可用模型（普通用户默认）
    ├── 模型管理（管理员默认）
    ├── 模型详情
    │   ├── 概览
    │   ├── 供应商与协议
    │   ├── 访问与流量策略
    │   ├── 草稿/发布/生效
    │   └── 审计
    └── 新增/编辑模型
```

### 5.2 广场模型聚合边界

首版支持以下两种供应商接入方式：

1. **新建专属接入**：在模型编辑器内创建，只被当前模型引用；这是默认方式。
2. **绑定已有接入**：从当前环境已有 Provider 中选择；这是管理员高级功能。修改共享接入时
   必须展示所有受影响模型。

专属或共享只是控制台所有权语义。发布到 rnacos 后都表现为标准 Provider Data ID，ai-server
不感知该差别。

## 6. 页面与交互需求

### 6.1 模型广场列表

管理员列表每张卡片至少显示：

- 展示名称、逻辑模型名和简短说明。
- OpenAI、Anthropic 协议徽标；徽标必须附文本，不只用颜色。
- 主供应商数量、Fallback 是否配置、API Token 总体安全摘要。
- 草稿状态、最近发布状态、实例生效状态三个独立状态栏。
- 最近修改人和时间、最近 release 编号。
- 校验错误或高风险变更数量。

普通用户卡片只显示展示名称、逻辑模型名、说明、已发布协议入口、本人访问权限和实例生效
摘要。不得根据管理员未发布草稿改变普通用户视图。

列表支持：

- 按展示名称、逻辑模型名搜索。
- 按协议、本人可访问、草稿状态、发布状态、生效状态筛选。
- 按最近更新、名称排序。
- cursor 分页；服务端使用白名单字段，不接受任意 SQL 排序片段。
- 空状态区分“尚未配置模型”“筛选无结果”“无权访问任何模型”。

### 6.2 新增模型向导

向导分为五步，允许随时保存草稿：

1. **基本信息**：展示名称、逻辑模型名、说明和标签。
2. **供应商接入**：供应商显示名称、Base URL、专属/共享方式、主/Fallback 角色。
3. **协议映射**：选择 OpenAI、Anthropic 或两者，填写每项路径和供应商上游模型名。
4. **API Token**：维护 Token 名和值，或明确选择无凭据调用。
5. **访问与流量策略**：用户组、主 Provider 顺序、Fallback、负载均衡和可选限流。

完成页显示静态协议矩阵、生成的 Data ID、脱敏变更、风险和下一步。点击“保存草稿”只写
MySQL，不得写 rnacos，也不得显示“已发布”。

### 6.3 基本信息

| 字段       | 必填 | 规则                                                          |
| ---------- | ---- | ------------------------------------------------------------- |
| 展示名称   | 是   | 1..100 个 Unicode 字符；首尾空白去除；仅用于控制台            |
| 逻辑模型名 | 是   | 1..128 字节，`[A-Za-z0-9_.-]`，环境内唯一，创建后不可原地修改 |
| 说明       | 否   | 最多 2,000 个 Unicode 字符；纯文本展示                        |
| 标签       | 否   | 最多 20 个，每项 1..32 字符；环境内规范化去重                 |

逻辑模型名重命名使用“复制为新模型 → 迁移调用方 → 发布 → 归档旧模型”，不得直接修改已发布
模型身份。

### 6.4 供应商接入

| 字段           | 必填 | 规则                                                          |
| -------------- | ---- | ------------------------------------------------------------- |
| 供应商显示名称 | 是   | 1..100 字符，仅用于控制台                                     |
| Provider 标识  | 自动 | 1..128 字节，`[A-Za-z0-9_-]`，环境内唯一，与 Data ID 后缀一致 |
| Base URL       | 是   | `http://`、`https://` 或 `service://`，保存时移除尾部 `/`     |
| 路由角色       | 是   | `PRIMARY` 或 `FALLBACK`                                       |
| 主供应商顺序   | 条件 | PRIMARY 内唯一非负整数；提供上移/下移按钮，不只支持拖拽       |

一个模型必须至少有一个主供应商或一个 Fallback，推荐至少一个主供应商。最多一个 Fallback，
Fallback 不能同时出现在主供应商列表。

Provider 标识创建后不可原地修改。专属 Provider 默认使用稳定后端生成值，不能由展示名称
实时派生，以免改名造成 Data ID 变化。

Base URL 规则与 ai-server 保持一致：

- HTTP/HTTPS 必须有合法主机；端口为 `1..65535`；IPv6 literal 使用方括号。
- 不允许 userinfo、query、fragment、反斜杠。
- 可包含基础路径，协议 `path` 在其后拼接。
- `service://` 后是 1..1024 字节服务名，不允许空白、`/`、`?`、`#`。
- `service://` 使用 ai-server 的 NamingService 发现语义；页面展示服务实例摘要，但不能把
  “配置了服务名”标成“存在可用实例”。

### 6.5 协议映射

每个供应商接入至少启用一种首版协议，同一协议类型只能配置一次：

| UI 协议   | rnacos `type`             | 默认路径               | 上游模型名 |
| --------- | ------------------------- | ---------------------- | ---------- |
| OpenAI    | `openai-chat-completions` | `/v1/chat/completions` | 非空       |
| Anthropic | `anthropic-messages`      | `/v1/messages`         | 非空       |

协议项规则：

- `path` 必须以 `/` 开头，不能为空，不允许控制字符；控制台上限 2,048 字节。
- `upstreamModelName` 去除首尾空白后非空，控制台上限 512 字节。
- 同时启用两种协议时，用户可以复制另一协议的上游模型名，但系统不假设两者一定相同。
- 关闭协议会改变模型静态协议覆盖。若导致某种入口没有任何主或 Fallback 候选，必须警告；
  两种入口均无候选时允许保存草稿但禁止发布。
- 不显示 `openai-embedding` 选项；导入含该项的外部配置时仅以“不受模型广场管理”的只读
  兼容项展示，不能误报为可调用协议。

### 6.6 供应商 API Token 池

每个供应商接入维护零个或多个 Token。零个 Token 表示 ai-server 调用上游时不发送
`Authorization`，必须由管理员明确勾选“此接入无需凭据”。

| 字段     | 规则                                                             |
| -------- | ---------------------------------------------------------------- |
| Token 名 | Provider 内唯一；1..128 字符；禁止控制字符；创建后不可直接重命名 |
| Token 值 | 1..8192 字节；只写；禁止 CR/LF/NUL；不做 trim，避免改变真实凭据  |
| 指纹     | 后端以密钥化摘要生成，只返回后 6 位；不能由指纹恢复 Token        |
| 更新时间 | UTC 存储，按用户时区展示                                         |

安全交互：

- 新增 Token 的值仅存在于当前请求，保存成功后立即清空输入框，响应不返回明文。
- 已保存 Token 只显示名称、`已配置`、指纹后缀、更新时间和最近发布状态。
- 编辑整个供应商时，每个现有 Token 必须显式保持 `keep`；空值不能代表删除。
- 替换使用 `secretAction: replace` 和新值；删除使用 `secretAction: delete`；普通字段保存使用
  `secretAction: keep`。
- 轮换推荐“新增新名称 Token → 发布并观察 → 删除旧 Token → 再次发布”。
- 直接替换同名 Token、删除最后一个 Token、从有凭据切换为无凭据都属于高风险操作，要求
  二次确认和变更原因。
- 差异、审计、日志、异常、Trace、浏览器状态和埋点禁止记录 Token 值。
- 共享供应商的 Token 变更必须列出全部引用模型，不能只显示当前模型。

Token 池不是简单轮询列表。ai-server 会基于 route key、Provider 名和 Token 名进行确定性
排序，并跳过运行时暂时不可用的 Token；模型广场只能展示配置池和运行时汇总，不能承诺
某次请求固定使用某个 Token。

### 6.7 访问与流量策略

模型广场复用上位需求中的模型配置：

- `allow-user-groups` 为空表示所有已认证用户均可访问；扩大为所有用户属于高风险变更。
- 主 Provider 可以有多个；Fallback 最多一个且不能与主 Provider 重复。
- 负载策略固定 `rendezvous-hash`，route key 来源固定 `prompt-prefix`，界面只读展示。
- `prefix-max-bytes` 默认 2048；`max-primary-attempts` 默认 0；Fallback 默认启用。
- 可重试状态默认 429、502、503、504。
- 模型 Token 限流可选，按 `username + logical model` 计数；与供应商 API Token 数量无关。

### 6.8 静态协议覆盖矩阵

编辑器和详情页按主 Provider、Fallback 分别计算：

| Provider | 路由角色 | OpenAI | Anthropic | Token 摘要 | 配置状态 |
| -------- | -------- | ------ | --------- | ---------- | -------- |
| 示例 A   | PRIMARY  | 可配置 | 可配置    | 2 个已配置 | 草稿     |
| 示例 B   | FALLBACK | 缺失   | 可配置    | 无凭据     | 已发布   |

协议状态至少包括：`SUPPORTED`、`UNSUPPORTED`、`INVALID`。模型聚合状态包括：

- `FULL`：OpenAI 和 Anthropic 都至少有一个静态候选。
- `PARTIAL`：只有一种协议有静态候选。
- `NONE`：两种协议都没有候选，禁止发布。

静态候选不代表运行时必定可用。页面必须说明 ai-server 还会过滤缺失配置、Provider 熔断、
暂停 Token 和无可用实例的 `service://` 接入。

### 6.9 详情与差异

管理员详情页同时显示：

- 当前草稿、最近发布和实例生效三栏，不用单一“状态”覆盖。
- 逻辑模型和 Provider 的规范化配置摘要。
- 每个协议的静态候选和 Fallback 路径。
- Token 安全元数据，不显示值。
- 草稿相对基线 release 的脱敏差异。
- 生成的固定 group 与 Data ID。
- 最近发布的逐资源结果和逐实例结果。
- 共享 Provider 的反向引用模型。

差异中供应商 Token 只允许出现：新增名称、删除名称、同名替换、指纹后缀变化。任何序列化
异常都必须 fail closed，不能退回展示原始请求或 rnacos 内容。

### 6.10 复制、归档和删除

- 复制模型必须生成新的逻辑模型名和新的专属 Provider 标识；不得复制 Token 明文到浏览器。
- 管理员可在后端明确选择“复用现有 secret 引用”，该动作要审计且只允许同环境。
- 归档只是控制台目录状态，不等于从 rnacos 删除模型。
- 删除已发布模型必须先创建从 `ploto.ai-llm.models` 移除该项的发布。
- 不再被引用的 Provider 必须在后续独立清理发布中删除，避免多 Data ID 非事务变更扩大风险。
- 历史 release、发布结果和审计记录不能随模型归档而删除。

## 7. 草稿、发布与生效需求

### 7.1 三种状态

| 状态层      | 事实来源                                  | 页面用语             |
| ----------- | ----------------------------------------- | -------------------- |
| 草稿        | MySQL 环境级草稿及 revision               | 已保存草稿/无草稿    |
| rnacos 发布 | 不可变 release、逐 Data ID 写入和回读 MD5 | 已发布/部分发布/失败 |
| 实例生效    | 每个 ai-server 实例报告的接受证据         | 已生效/部分生效/未知 |

“保存成功”的 Toast 只能表示草稿已保存。“发布成功”只表示目标 rnacos 资源写入并回读一致。
在缺少实例级配置身份能力时必须显示“生效未知”，不能以 `/ready` 或健康检查代替。

### 7.2 保存草稿

- 模型编辑发生在环境级草稿工作区，可与 Provider、用户组等关联变更一起校验。
- 保存只依赖 MySQL 和 secret 服务，不要求 rnacos 或 ai-server 在线。
- 所有更新使用 revision/ETag 乐观锁；冲突返回 `412`，页面提供刷新和重新应用变更。
- Token secret 保存失败时整个业务事务失败，不得留下声称“已配置”的孤立元数据。
- 每次保存记录操作者、原因、字段级脱敏差异和 correlation ID。

### 7.3 三层校验

1. **字段层**：名称、Base URL、协议路径、上游模型名、Token 动作和数值范围合法。
2. **关系层**：Provider 引用存在，主/Fallback 不重复，Token 名唯一，协议类型唯一，用户组
   存在，共享 Provider 环境一致。
3. **环境图层**：模型至少存在一个路由候选，两种协议覆盖符合发布策略，所有所需 secret
   可解析，Data ID 固定且无冲突，基线 revision/MD5 无漂移。

校验结果必须包含稳定错误码、JSON Pointer 字段路径、严重级别和修复建议。`ERROR` 阻止
发布，`WARNING` 要求确认，`INFO` 仅说明。

### 7.4 发布顺序与部分成功

发布前必须创建不可变 release 和逐资源步骤。对新增模型的推荐顺序是：

1. 写入并回读所有新增或变更的 Provider Data ID。
2. 写入并回读聚合的 `ploto.ai-llm.models`。
3. 等待目标 ai-server 实例报告接受结果。
4. 在后续独立清理 release 中处理已无引用 Provider。

多个 Data ID 不构成事务。更新一个已被线上模型引用的 Provider 时，它可能在模型总表写入
前就影响运行请求；发布确认页必须明确展示此风险。失败时逐项保留 `pending`、`writing`、
`published`、`failed`、`skipped`，不能把部分成功压缩成一个布尔值。

### 7.5 回滚

- 回滚从历史 release 的不可变内容创建新 release，不覆盖历史。
- 回滚前重新验证当前环境、secret 可用性、rnacos MD5 和目标实例集合。
- 已销毁的历史 secret 不能被静默恢复；必须要求管理员输入替代 Token 或取消回滚。
- 回滚仍按 Provider → models 的顺序执行，并记录新的逐资源和逐实例结果。

## 8. 状态与可用性定义

### 8.1 模型生命周期

| 状态       | 含义                                            |
| ---------- | ----------------------------------------------- |
| `ACTIVE`   | 出现在管理目录中，可进入草稿和发布流程          |
| `ARCHIVED` | 不在默认列表中，但身份、历史 release 和审计保留 |

生命周期不等于配置状态。`ARCHIVED` 模型若尚未从 rnacos 发布移除，仍可能被 ai-server 调用，
页面必须显示这一事实。

### 8.2 聚合展示状态

每张管理员卡片必须同时包含：

- `draftState`: `NONE | MODIFIED | INVALID | CONFLICTED`
- `publicationState`: `NEVER | PUBLISHED | PARTIAL | FAILED | DRIFTED`
- `activationState`: `UNKNOWN | PENDING | EFFECTIVE | PARTIAL | REJECTED`

普通用户只消费最近已发布且未漂移的内容；若实例生效未知，仍应明确标注未知，而不是隐藏。

## 9. API 与错误需求

API 详细结构见设计文档，需求层约束如下：

- 全部路由位于 `/api`，环境身份来自路径和授权上下文，不能相信请求体中的环境 ID。
- 普通用户列表只读取已发布投影；管理员可显式选择草稿视图。
- 列表使用 cursor 和 `limit + 1`，不使用前端传入的 SQL 字段。
- 创建、复制、Token 写入等动作要求 `Idempotency-Key`。
- 修改和删除要求 `If-Match`；revision 不匹配返回 `412 REVISION_CONFLICT`。
- secret 写接口与响应使用 `Cache-Control: no-store`，禁止记录请求体。
- 错误响应至少包含 `code`、`message`、`field`、`correlationId`。
- 服务端运行 SQL 只能是单表、参数化的简单语句，不使用 JOIN、子查询、CTE、UNION 或复杂
  聚合；跨表关系由服务层分批读取并在 TypeScript 中组装。

建议稳定错误码：

| 错误码                            | 场景                                 |
| --------------------------------- | ------------------------------------ |
| `MODEL_NAME_INVALID`              | 逻辑模型名不符合 ai-server 规则      |
| `MODEL_NAME_CONFLICT`             | 环境内逻辑模型名重复                 |
| `PROVIDER_NAME_CONFLICT`          | Provider 标识或 Data ID 冲突         |
| `PROVIDER_BASE_URL_INVALID`       | Base URL 不符合上游解析规则          |
| `PROTOCOL_REQUIRED`               | 供应商没有任何受支持协议             |
| `PROTOCOL_DUPLICATED`             | 同一 Provider 重复协议类型           |
| `PROTOCOL_COVERAGE_EMPTY`         | 模型无 OpenAI 或 Anthropic 静态候选  |
| `UPSTREAM_MODEL_REQUIRED`         | 协议缺少供应商上游模型名             |
| `API_TOKEN_NAME_CONFLICT`         | Provider 内 Token 名重复             |
| `API_TOKEN_SECRET_REQUIRED`       | 新增或替换没有提供 Token             |
| `SECRET_ACTION_INVALID`           | keep/replace/delete 与字段组合不合法 |
| `SHARED_PROVIDER_IMPACT_REQUIRED` | 共享 Provider 变更未确认影响范围     |
| `REVISION_CONFLICT`               | ETag 与当前草稿 revision 不一致      |
| `RELEASE_DRIFTED`                 | rnacos 当前 MD5 与发布基线不一致     |

## 10. 安全、隐私与审计

### 10.1 Secret 安全

- Token 通过 KMS envelope encryption 或 Secret Manager 引用保存，业务表不保存明文。
- 后端仅在发布渲染的最小内存窗口解密，并在完成后主动释放引用；不得写临时文件。
- rnacos 因 ai-server 当前协议需要包含明文 Token，必须使用专用 ACL、固定 group/Data ID 前缀、
  网络隔离和受控备份。
- 控制台前端不能直接访问 rnacos Provider 内容。
- 供应商页面禁用会采集表单值的埋点、会话回放和错误正文上传。
- Token 输入使用密码控件，默认关闭自动完成，不提供“复制已保存 Token”。

### 10.2 审计事件

至少记录：

- `model.created`、`model.updated`、`model.archived`、`model.copied`
- `provider.created`、`provider.updated`、`provider.bound`、`provider.unbound`
- `provider.protocol_changed`
- `provider_token.added`、`provider_token.replaced`、`provider_token.deleted`
- `model.validation_completed`
- 关联的草稿提交、审批、发布、回滚和漂移处理事件

事件包含 actor、角色、环境、资源 ID、revision、脱敏差异、影响模型、原因、correlation ID 和
UTC 时间。Token 事件只能记录名称、动作和前后指纹后缀。

## 11. 非功能需求

### 11.1 性能与容量

- 默认支持每环境 1,000 个模型、2,000 个 Provider、每 Provider 100 个 Token。
- 模型列表在目标容量内 P95 小于 2 秒，默认每页 30，最大 100。
- 管理列表使用单表投影，不在请求路径执行跨表 SQL 聚合。
- 完整环境图校验可异步执行；页面显示进度且刷新后可恢复。
- 生成 rnacos 内容前检查单 Data ID 大小上限，不能静默截断。

### 11.2 可用性与一致性

- rnacos 不可用时仍可浏览和保存草稿，但禁止执行发布。
- secret 服务不可用时可浏览脱敏元数据，禁止新增、替换和需要解密的发布。
- 发布任务可重入，重试复用同一 release 和资源步骤，不生成重复版本。
- 投影更新失败不改变事实表；后台可从事实表重建，并在页面标注数据可能延迟。

### 11.3 可访问性与响应式

- 键盘可完成列表、向导、Token 操作、Provider 排序、确认和错误定位。
- 协议、风险和三层状态均同时使用文本/图标，不以颜色作为唯一信息。
- 错误摘要链接到具体表单控件，提交失败后焦点移至首个错误。
- 窄屏用分段卡片展示，始终保留逻辑模型名和三层状态。
- 离开有未保存变更的页面前提示；尊重 `prefers-reduced-motion`。

### 11.4 可测试性

- 后端单元测试不依赖真实 MySQL、rnacos、ai-server、时钟或公网。
- Provider Base URL、模型和协议校验维护与 C++ `LlmConfigCodec` 对齐的 golden fixtures。
- secret 服务、rnacos 发布器、实例状态采集器和时钟通过 typed interface 注入。
- 前端复杂向导落地前应引入组件/交互测试；同时保留桌面和移动端人工验收。

## 12. 验收标准

### 12.1 新增双协议模型

1. 管理员在开发环境创建逻辑模型 `chat-pro`。
2. 新建一个主供应商接入，同时启用 OpenAI 和 Anthropic。
3. 两种协议分别保存路径和供应商上游模型名。
4. 新增两个不同名称的 API Token，保存后页面和网络响应均不出现明文。
5. 草稿详情显示两个 Provider 协议项、一个模型引用和 `FULL` 静态覆盖。
6. 保存不访问 rnacos；提交发布后先写 Provider Data ID，再写 models Data ID。
7. rnacos 写入和实例生效使用独立状态展示。

### 12.2 单协议与协议缺口

1. 供应商只启用 OpenAI 时，卡片显示 OpenAI 支持、Anthropic 不支持。
2. 增加只支持 Anthropic 的另一个主供应商后，模型聚合覆盖变为 `FULL`。
3. 移除全部协议映射时允许保存无效草稿，但校验返回字段路径并禁止发布。

### 12.3 Token 轮换

1. 新 Token 保存后只显示名称、已配置状态和指纹后缀。
2. 编辑其他字段使用 `keep` 不改变 secret 引用和指纹。
3. 新旧 Token 可在同一 Provider 并存并发布。
4. 删除旧 Token 要求原因；差异和审计不含明文。
5. 删除最后一个 Token 时必须二次确认无凭据调用风险。

### 12.4 权限和信息隔离

1. 普通用户只能读取已发布且对本人可见的模型目录。
2. 普通用户请求管理详情、草稿或 Token 接口返回 `403`。
3. 管理员也不能通过任何 GET 接口回读 Token 明文。
4. 浏览器刷新、后退、错误上报和审计导出不泄露 Token。

### 12.5 状态真实性

1. 保存草稿后只显示“草稿已保存”。
2. Provider 写入成功而 models 写入失败时显示“部分发布”及逐资源结果。
3. rnacos 全部写入成功但缺少实例证据时显示“已发布 / 生效未知”。
4. 只有目标实例均报告接受目标配置时才显示“已生效”。

### 12.6 SQL 约束

1. 模型广场所有运行时 repository 查询均为单表参数化 SQL。
2. SQL 静态检查和代码评审中不存在 JOIN、子查询、CTE、UNION 或数据库端复杂聚合。
3. 跨模型、Provider、协议和 Token 的组装在服务层通过 Map 完成。
4. 列表从单表读模型投影，分页使用 `LIMIT + 1`，不执行 `COUNT(*)`。

## 13. 分阶段交付

### 13.1 MVP

- 管理员模型列表、详情和五步编辑器。
- 专属供应商接入，OpenAI/Anthropic 双协议配置。
- 多 Token 的新增、保持、替换、删除和脱敏差异。
- 主 Provider、单个 Fallback、用户组和基础流量策略。
- 三层校验，接入既有草稿、审批、发布、回滚和审计。
- 普通用户只读模型目录。

### 13.2 增强版

- 共享 Provider 绑定与完整影响分析。
- 运行时协议/Token/服务实例可用性汇总。
- 外部 rnacos Provider 和 models 配置导入接管。
- 模型复制时安全复用已有 secret 引用。
- 更丰富的标签、所有者、成本元数据和变更模板。

### 13.3 上游能力就绪后

- Provider 认证头策略，例如 Anthropic `x-api-key`。
- `openai-embedding` 入站路由与广场协议徽标。
- 实例上报已接受 release/Data ID MD5 的强生效证明。
- 不暴露 secret 到 rnacos 明文配置的 secret 引用协议。
