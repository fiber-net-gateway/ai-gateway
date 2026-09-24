# Responses 无状态实现与验证

本实现对应 [设计方案](openai-responses-stateless-design.md)，入口为 `POST /v1/responses`。

## 使用契约

- Provider 必须显式配置 `openai-responses`；管理端对应 `OPENAI_RESPONSES`。
  Chat Completions、Responses 和 Anthropic 各自选路，不相互转换。
- 网关删除所有顶层 `previous_response_id`、`conversation`，覆盖所有顶层 store/background，
  出站仅保留一个 `store:false` 和一个 `background:false`。
- 客户端每次提交完整 `input`；仅有历史引用不能补回上下文。
  `input[].type=item_reference` 返回 400；完整 message、function call/output 和 encrypted reasoning items 保留。
- JSON 和 SSE 保留 Provider 原生格式。JSON 必须为已终止的 Response；SSE 必须有完整、由空行结束的终止事件。
  HTTP 200 的 failed/incomplete 会在审计中记为失败；已有合法终止 usage 仍用于限流结算。
- 没有终止事件、无效 JSON、状态策略回显违规均不能作为成功。
  流错误仅在已发送字节处于完整 SSE 边界时补安全 error 事件；半帧直接断开。
- Responses 的 FILE/HTTP 审计都不采集输入、输出、工具参数、历史 ID、encrypted_content 或正文 hash。
  审计 schema 保持 v6，`client_protocol=openai-responses`。
- 不提供检索、取消、删除、Conversations、后台任务、WebSocket、compact 和恢复流接口。
  Provider 外部工具资源兼容性和其数据留存政策不属于网关的会话无状态保证。

请求示例见 [responses.http](../native/ai-server/http/responses.http)。演示 Provider 同时支持 JSON 和 SSE。

## 实现入口

- `LlmBodyExtractor/Modifier`：单次扫描、根字段元数据、原正文切片改写和稳定路由摘要；每次重试从原正文开始。
- `ResponsesObservation`：共享 JSON/SSE 观察器，终态、usage、首 token 和安全错误分类。
- `LlmRequestHandler`：独立 Responses relay、绝对 drain deadline、终态处理、结算和最小化审计。
- `AiServerMetrics`：第三协议的请求/Provider/token 指标，以及有限基数的 Responses 结果和改写计数。
- `ResponsesProtocolTest`：请求边界、配置/路由隔离、终态/usage 和 SSE 分片。
- `ResponsesProxyIntegrationTest`：loopback Provider、重试、审计、截断和下游断开后的排空。
  测试共用 `LlmProxyTestSupport.h`，在 FILE 和 HTTP 构建中均注册。
- 管理端：Provider 编辑、模型覆盖/筛选/示例、发布 JSON、调用协议筛选；沿用草稿、发布、实例生效三个独立状态。

## 发布顺序

1. 执行迁移 `009-openai-responses-protocol`，扩展协议 CHECK 并新增 responses_coverage。
   历史投影默认 UNSUPPORTED；不会补造历史发布记录。
2. 升级全部 ai-server 实例，使其能够解析新协议配置；迁移不代表实例已接受配置。
3. 部署管理端，新增 Responses 映射，通过既有不可变 release 流程发布 Provider 和模型配置。
4. 使用明确的 Provider/模型验证 JSON、SSE、自包含多轮和工具结果回传，观察结果、用量和策略改写指标。

旧版 ai-server 会拒绝新协议配置，因此不要先发布配置再升级实例。
回滚应用前应通过新 release 去掉新协议映射；不改写历史 release，不将数据库迁移当成运行时激活证据。

## 本地验证

验证日期：2026-09-24。测试只使用合成正文、临时凭据和 loopback 服务。

| 检查                       | 结果                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| FILE 审计完整 CTest        | 178/178 通过                                                                      |
| HTTP 审计完整 CTest        | 57/57 通过                                                                        |
| 新增 Responses 聚焦测试    | 19/19，两种审计构建均执行                                                         |
| 路由 HTTP 测试             | 2/2，包括历史资源拒绝                                                             |
| ASan（FILE，开启泄漏检测） | Responses、LlmBody、LlmProtocol 共 55/55 通过，无 sanitizer 报告                  |
| ai-server 可执行文件       | Release HTTP 构建成功                                                             |
| 控制面                     | typecheck、34 个后端测试、format:check、生产 build 通过                           |
| 浏览器                     | Chrome，1440px/390px；第三协议启用、默认路径、Tab 访问、无横向溢出、无运行时异常  |
| Demo Provider              | loopback JSON 与 8 个 typed SSE 事件，序号递增、completed、store/background=false |
| 格式与补丁                 | `./format_code.sh`、Prettier 和 `git diff --check` 通过                           |

为适应本地内存容量，native 构建采用 `--parallel 2`。FILE/HTTP 在同一构建目录顺序执行，
最终 `native/build` 为 HTTP；ASan 使用独立 `native/build-responses-asan`，未改 Fiber pin。
实际矩阵命令（对 FILE、HTTP 分别执行）为：

```bash
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release \
  -DAI_SERVER_AUDIT_TRANSPORT=FILE -DFIBER_BUILD_TESTS=ON
cmake --build native/build --target fiber_ai_server_tests --parallel 2
ctest --test-dir native/build --output-on-failure -E '_NOT_BUILT$'
# 将上面的 FILE 替换为 HTTP，再顺序运行相同构建和 CTest。
cmake --build native/build --target fiber_app_ai_server --parallel 2
npm run typecheck
npm test
npm run format:check
npm run build
git diff --check
```

ASan 配置为 Debug、`-fsanitize=address -fno-omit-frame-pointer`，测试命令为：

```bash
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
  native/build-responses-asan/ai-server/fiber_ai_server_tests \
  --gtest_filter='Responses*:LlmProtocolTest.*:LlmBodyTest.*'
```

### 本地性能探针

同一 Release 构建中测量 parse + rewrite。输入正文在计时前准备；每次使用新 BufPool/IoBufNodePool，
保留原始 IoBuf 切片，替换上游模型名。Chat 使用单条 user message，Responses 使用字符串 input。
8/128 KiB 各循环 300 次，1/4 MiB 各循环 30 次。通过 malloc/calloc/realloc/posix_memalign 和普通 new
包装统计探针区间的分配请求；不将输入预分配或进程常驻内存算作改写分配。

| input 规模 | Chat μs/次 | Responses μs/次 | Chat 分配次数/字节 | Responses 分配次数/字节 |
| ---------- | ---------: | --------------: | -----------------: | ----------------------: |
| 8 KiB      |      22.84 |           24.76 |           6 / 4375 |               10 / 4618 |
| 128 KiB    |     281.42 |          326.08 |           6 / 4375 |               10 / 4618 |
| 1 MiB      |    2196.21 |         2361.70 |           6 / 4375 |               10 / 4618 |
| 接近 4 MiB |    8798.76 |         8926.52 |           6 / 4375 |               10 / 4618 |

该 fixture 的输出链节点为 Chat 3、Responses 6；分配量不随正文尺寸增加。
短 output_text.delta 观察器循环 100000 次，约 0.421 μs/次，探针区间无堆分配。
整个混合探针进程最大 RSS 为 16904 KiB，包含输入准备和所有 case，不是单次请求的峰值。
这些是在共享开发机上的局部测量，不是完整 HTTP 压测、稳定 P99 或生产容量结论；
多 attempt 和断连的正确性由 loopback 回归验证，尚未单独测量它们的性能分布。

环境没有 MySQL 服务和 Docker；迁移尚未进行真实 MySQL 升级/重跑验证。
未连接真实 OpenAI/第三方 Provider，也没有执行生产发布或实例激活验证。
300 秒 drain deadline 的真实时长与持续 keepalive 压测未执行；已通过断开后继续排空并结算 usage 的回归。
浏览器验证未覆盖每一种历史配置和所有发布审批流程；这些状态仍沿用既有实现。
