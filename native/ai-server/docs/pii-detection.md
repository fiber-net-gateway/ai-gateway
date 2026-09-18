# PII 检测原型设计（手机号 / 邮箱 / 身份证）

## 1. 背景与决策

ai-gateway 作为企业 LLM 流量的数据面，请求体中经常携带用户自然语言文本。手机号、
邮箱、身份证号是其中最高频的敏感信息。本文档定义数据面内的 PII 检测原型：一个独
立的检测库（`src/pii/`）加完整设计，按已确认的范围决策，**不挂接请求路径**，为后
续策略（观测、掩码、拦截）提供基础。

三条决策依据，来自对 LiteLLM（`.temp/litellm`）和 Presidio（`.temp/presidio`）
的源码分析：

1. **确定性实体不需要 NER 模型。** Presidio 对三类实体的处理本质是"正则形状 +
   代码校验"：generic recognizer 是 11 个带校验函数的正则（IBAN、信用卡 Luhn、
   email 等），打分是启发式叠加而非概率。手机号/邮箱/身份证号完全可归入此类：
   身份证自带 GB 11643-1999 校验码，是比任何模型都强的确认信号。
2. **Presidio 没有中国身份证 recognizer。** 其 country_specific 目录覆盖 18 个国
   家（美、英、日、韩、新加坡、澳大利亚等），不含 CN；手机号识别依赖
   python-phonenumbers 的 `SUPPORTED_REGIONS`，默认区域不含 CN。外挂 Presidio 服
   务（LiteLLM `presidio_analyzer_api_base` 指向的独立 Flask/HTTP 进程）意味着每
   个请求一次额外 HTTP 往返，与数据面"性能优先、不阻塞 EventLoop"的约束冲突。
3. **检测与变换必须分离。** LiteLLM 的教训：presidio 掩码后把 `pii_tokens` 映射
   表写进 `request_data["metadata"]`，而 metadata 不做脱敏直接落日志，等于把还原
   映射和被掩码的原文一起存了下来。本设计第一阶段只做检测，任何掩码/还原方案都
   以"映射表绝不落日志/审计"为硬约束（见第 7 节）。

因此：**在 ai-server 数据面内用 C++ 自研确定性检测**，规则语义向 Presidio 的
recognizer/score/validate_result 模型对齐，集成形态向 LiteLLM 的 guardrail 事件
钩子模型对齐。

## 2. 参考架构对照

| Presidio / LiteLLM 概念 | 本设计对应 | 差异说明 |
| --- | --- | --- |
| Recognizer（注册进 RecognizerRegistry） | `scan_phones` / `scan_emails` / `scan_resident_ids` 三个函数 | 函数化简写；无插件注册机制，新增实体 = 新函数 + 正则 + 测试 |
| PatternRecognizer 打分（`re.fullmatch` 命中给 0.4 基础分） | 正则形状分 0.4 / 0.5 | 数值分层语义对齐 Presidio 的启发式区间 |
| `validate_result`（Luhn 等校验函数） | GB 11643-1999 MOD 11-2 校验码 + 日历校验 | 校验通过升到 0.95，失败保留 0.4 弱信号（Presidio 语义：校验失败不否决，只降信） |
| LemmaContextAwareEnhancer（上下文词加分） | 不做（路线图） | Presidio 对 "phone" 等关键词邻域加分；首版不需要 |
| AnalyzerEngine allow_list / deny_list | 不做（路线图） | 需要业务白名单（如测试账号）时再加 |
| score_threshold | `PiiScanOptions::min_score` | 同义 |
| LiteLLM guardrail `pre_call_hook`（可改写请求） | 路线图中的挂接点（第 7 节） | 事件位置一致：body 解析后、路由前 |
| LiteLLM presidio 掩码（`<PHONE_NUMBER_1>` 编号占位符 + `metadata.pii_tokens` 还原表） | 路线图（第 7 节） | 采纳其编号占位符与"倒序替换防坐标漂移"，否决其映射表落日志的做法 |
| Presidio Anonymizer 独立 HTTP 服务 | 不需要 | 检测与替换都在进程内，无往返 |

## 3. 规范规则定义

以下正则为**规范定义**（normative），实现与文档必须一致。偏移量一律是**字节偏移**
（UTF-8），与 JSON 解析产出的 token 偏移同构，span 为 `[start, end)`。

### 3.1 大陆手机号

```text
(?:\+?86[- ]?)?1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}
```

- 号段 `1[3-9]`：13x–19x 全部合法号段，共 11 位（3+4+4 分组）。
- 国际前缀 `\+?86` 可选，后跟至多一个 `-` 或空格；三组数字之间各允许至多一个
  `-` 或空格。支持 `13812345678`、`+8613812345678`、`138-1234-5678`、
  `+86 138 1234 5678` 等。括号形式 `(138)1234 5678` 不识别（分隔符仅 `-` 和空
  格）。
- **边界规则**：匹配起点前一字节与终点后一字节都不得是 ASCII 数字。该规则同时消
  解"18 位身份证内嵌 11 位手机号"的误报——身份证内部相邻字符全是数字，任何内部
  窗口都过不了边界检查。
- **评分**：裸 11 位 = **0.5**（形状信）；带 +86/86 前缀 = **0.85**（前缀本身是
  国家码形状的强信号）。

### 3.2 邮箱

```text
[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}
```

- 本地部分与域标签允许的字符集合与主流邮件正则一致；TLD 限 ASCII 字母且 ≥ 2。
- 尾部句点、逗号等标点不进入 span（`a@b.com.` 匹配到 `com` 为止）。
- 无边界检查：字符类自身天然界定；本地部分允许连续的 `.`（原型接受，RFC 5321
  严格校验不在范围）。
- **评分**：单层 **0.8**。

### 3.3 居民身份证（18 位）

```text
[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]
```

结构：6 位地址码（首位非 0）+ 8 位出生日期（年份限 1800–2099）+ 3 位顺序码 + 1
位校验码（数字或 X/x）。

- **边界规则**：起点前一字节不得是数字；终点后一字节不得是数字，也不得是 `X`/`x`
  （后邻 X 意味着序列可能延长）。
- **日历校验**：正则只保证形状（`02-30`、`02-31` 形状合法）；代码按真实日历复
  核，含闰年（四年一闰、百年不闰、四百年再闰）。日期不存在 → **弃置**（不是身份
  证）。
- **校验码**：GB 11643-1999 / ISO 7064 MOD 11-2。前 17 位分别乘权重

  ```text
  7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2
  ```

  求和后 mod 11，以余数查映射 `"10X98765432"` 得期望校验码；`x` 与 `X` 等价。

- **评分**：结构与日历合法、校验码通过 = **0.95**；校验码错误 = **0.4**（弱信号
  保留，对应 Presidio validate_result 失败降信而非否决）；日历非法 = 弃置。
- 15 位旧证不检测（GB 11643-1999 已全面升位；如需支持，按 `yyMMdd` 两方案回溯
  校验码即可扩展）。

### 3.4 分层语义汇总

| 分值 | 含义 | 来源 |
| --- | --- | --- |
| 0.4 | 弱信号，保留供聚合分析 | 身份证形状+日历对但校验码错 |
| 0.5 | 形状可信 | 裸手机号 / 身份证结构分（无校验环节的实体用不到） |
| 0.8 | 很可能 | 邮箱完整结构 |
| 0.85 | 很可能+ | 带国家码前缀的手机号 |
| 0.95 | 确认 | 身份证校验码通过（1/11 偶然命中的前提下几乎确证） |

同 span 多候选（理论上不出现，防御性）：去重保留最高分。不同 span 重叠（如弱信
号身份证与手机号部分重叠）：双方保留，交给上层策略裁决。

## 4. 正则引擎：自研 NFA（参考 RE2）

### 4.1 为什么不用 RE2 / abseil-cpp

RE2 是该问题的标准答案（线性时间、无回溯灾难点），但现代 RE2 依赖 abseil-cpp：
两个依赖合计数十万行、显著拉长编译时间，而本仓库的全部需求只有**三个固定模式**。
Fiber SDK 本身刻意不提供正则（`StringsFuncs.h` 注释明确 defer）。结论：把 RE2 源
码下载到 `.temp/re2`（2025-11-05 版）作参考，自研一个约 700 行的最小引擎，语义
对齐 RE2 的 POSIX 模式（leftmost-longest），语法裁剪到三个模式所需子集。零新增
外部依赖。

### 4.2 引擎设计（`src/pii/Regex.h/.cpp`）

```text
pattern ──递归下降解析──▶ AST ──patch-list 片段发射──▶ Thompson NFA 程序
                                                          │
text ◀──────────────lockstep 模拟（leftmost-longest）◀────┘
```

- **指令集**：`Byte`（256 位字节集掩码 + 显式后继 `x`）、`Split`（epsilon 双分
  支 `x`/`y`）、`Accept`。每条指令的转移都是显式的，没有 fall-through，片段出口
  永远可以表达为待补丁槽位——这是 Russ Cox 文章与 RE2 `compile.cc` 的经典手法。
- **语法子集**：字面量、`.`（除 `\n`）、`[...]`/`[^...]`（范围、类内转义）、
  `(...)`/`(?:...)`、`|`、`* + ? {n} {n,} {n,m}`（上界 1000，程序上限 10 万条指
  令）。**不支持**锚点、捕获组、lookaround、反向引用；`{n,}` 展开为 n 份拷贝 +
  Star，`{n,m}` 展开为 n 份拷贝 + (m−n) 个 Quest。
- **可空模式拒绝**：能匹配空串的模式（`a*`、`a?`、`a{0,3}`）在编译期报错。检测
  场景没有空匹配语义，该约束同时简化了模拟器（每个起始位置注入的新线程至少要消
  耗一个字节才有意义）。
- **leftmost-longest**：Pike VM 模拟，线程列表 `(pc, start)` 按代际 stamp 去重
  （pc 去重保留最早 start，列表按 start 非递减序追加，天然偏向最左）。候选择优
  先最小 start、其次最大 end。这与 PCRE 的 leftmost-first（回溯第一个命中）不
  同：`a|ab` 在 `ab` 上匹配 `ab` 而非 `a`。
- **首字节集加速**：编译期计算所有可能起始字节的 256 位集合；无线程存活时跳过集
  合外的字节（RE2 的 prefix accelerator 思想）。三个 PII 模式的首字节集都很小
  （数字/字母/+），中文正文的大段字节会被整段跳过。
- **线程安全与零分配热路径**：`Regex` 对象编译后不可变（`const` + 移动构造），
  模拟用 `thread_local` 暂存向量（current/next 线程表、epsilon 栈、mark 数组），
  搜索路径除结果向量外无堆分配。复杂度 O(len(text) × 状态数)，无回溯、无指数风
  险（不存在嵌套量词歧义爆炸的输入类）。
- **UTF-8 安全性**：引擎按字节匹配；三个模式纯 ASCII；UTF-8 多字节序列的每个字
  节都 ≥ 0x80，永远落在任何 ASCII 类之外，因此中文正文既不会错切 span，也不会
  产生跨汉字的伪命中。测试专门验证了汉字句内字节偏移。

### 4.3 与 RE2 的语义差异清单

| 特性 | RE2 | 本引擎 |
| --- | --- | --- |
| 空串匹配 | 允许 | 编译期拒绝 |
| 捕获组 / submatch | 支持 | 不支持（检测只需 span，身份证含 18 字节定长可按位切片） |
| `{n,}` 上界 | 2^31 | 1000（防程序爆炸） |
| Unicode 类 / UTF-8 模式 | 支持 | 字节模式（PII 模式无需） |
| 锚点 `^ $ \b` | 支持 | 不支持（边界由检测代码显式判定，见 3.1/3.3） |

无 lookaround 时的边界策略是 RE2 生态的标准做法：模式只写主体，邻字符检查放在
匹配后的代码里（RE2 文档自身的建议路径），且比 lookbehind 更可测试。

## 5. API 与实现

```cpp
// src/pii/PiiEntity.h
enum class PiiEntityType : std::uint8_t { ChinaMobilePhone, EmailAddress, ChinaResidentId };

struct PiiMatch {
    PiiEntityType type;
    std::size_t start;   // 字节偏移，[start, end)
    std::size_t end;
    float score;         // 分层语义见第 3.4 节
};

struct PiiScanOptions {
    bool phone = true;
    bool email = true;
    bool resident_id = true;
    float min_score = 0.0F;   // Presidio score_threshold 同义
};

// src/pii/PiiDetector.h —— 唯一门面
class PiiDetector {
public:
    [[nodiscard]] static std::vector<PiiMatch> scan(std::string_view text,
                                                    const PiiScanOptions &options = {});
};
```

- 三个模式经 `Regex::compile` 编译为**函数内 static**（`error_program()` 惯用法，
  参考 `ProviderErrorClassifier.cpp`），首调用编译一次，之后共享只读；`FIBER_ASSERT`
  保证模式串正确（编译失败即程序错误，测试覆盖）。
- 每个 recognizer 独立游标扫描：命中且通过边界/校验 → 产出、游标跳 `end`；被拒
  （边界失败、日历非法）→ 游标退回 `start + 1` 重扫，保证被长候选遮蔽的重叠实体
  仍能被发现。
- 汇总排序 `(start, end, score desc)`，同 span 去重保最高分，最后过 `min_score`。
- `scan` 只做检测不做替换，无副作用，可并发调用。

## 6. 测试策略（`tests/NfaRegexTest.cpp`、`tests/PiiDetectorTest.cpp`，47 例）

**引擎层**（按语法特性逐项）：

- 字面量/`.`/字符类（范围、取反、类内转义、`[-a]`/`[a-]`/`[]]` 边角）
- 交替取最长（`a|ab`→`ab`；跨交替组合 `(?:a|ab)(?:c|bcd)` 取整体最长）
- 量词含 `{n,m}` 上下界回归（单 `a` 不构成 `a{2,}`）；可空模式编译拒绝矩阵
- `from` 偏移续扫、首字节集跳过的正确性、UTF-8 文本 + ASCII 模式
- 三个 PII 模式串本身可编译（守护检测器的 static 初始化）

**检测层**（每实体正/负/分层矩阵）：

- 手机号：裸号、`+86`/`86` 前缀、空格/连字符变体、中文句内字节偏移（"我的手机号
  是13812345678，请联系"→`(18,29)`）、12/13 位长数字串负例、`12x` 非法号段负例、
  身份证串内不产手机号、多号码顺序
- 邮箱：子域、`+tag`、大写、尾句点剔除、`邮箱…结束` 汉字邻接、裸 `@`/双 `@`/单
  字母 TLD 负例
- 身份证：GB 公开样例 `11010519491231002X`（校验码 X）、小写 x、序号 001 变体
  （校验码 1）、校验码错→0.4、`2023-02-30` 弃置、1900/2000 闰年差异、首位 0、
  前后邻数字/X 负例、多证顺序
- 通用：混合句按 start 排序、空输入、`min_score` 过滤、三开关独立关闭、1MB 复合
  文本（3×12000 实体）大规模冒烟

样例向量的校验码均按权重表手算核对（如 `110105194912310011`：权重和 165，
165 mod 11 = 0 → 校验码 `1`）。

## 7. 集成路线图（仅设计，未实现）

1. **配置开关**：新增 rnacos Data ID（如 `ploto.ai-llm.pii`，组 `LLM-SERVER`），
   载入 `LlmConfigSnapshot`：全局启停、每实体启停、策略模式
   （observe / mask / block）、`min_score`。遵守三态配置纪律：草稿（MySQL）→ 发布
   （rnacos）→ 实例激活（快照交换），激活证据独立记录。
2. **挂接点**：`LlmRequestHandler` 在 `ParsedLlmBody` 提取之后、路由选择之前调
   用（对应 LiteLLM `pre_call_hook` 位置）。该阶段已持有全部 content 文本和精确
   token 偏移，PII span 与 JSON token 偏移同构，无需二次解析。观测模式下仅
   计数不打日志（不落原文片段）。
3. **掩码 + 还原（若启用）**：采纳 LiteLLM 的编号占位符方案——
   `<PHONE_NUMBER_1>` 便于 LLM 保持指代一致性，响应侧按映射表倒序替换还原（倒序
   防坐标漂移）。硬约束：映射表只存在于请求生命周期内存中，**绝不进入
   metadata、审计批次、任何日志**（LiteLLM 把 `pii_tokens` 放进 metadata 且该字段
   不脱敏落日志，是明确的反面教材）。SSE 流式响应的还原需要增量缓冲边界处理，
   单列设计。
4. **审计与指标**：审计批次新增聚合字段（各类型命中计数，无原文）；Prometheus
   `pii_entities_total{type, policy}`。不新增请求体尺寸的日志。
5. **流式与性能**：检测只跑 request 侧 content 文本；response 侧观测模式跑非流
   式，流式仅在掩码+还原策略启用时做增量缓冲。1MB 文本全实体扫描在测试中为亚秒
   级，请求体量级（数 KB）代价可忽略，但正式挂接前需按 EventLoop 预算重测并考虑
   移交 worker 池。

## 8. 与 Presidio / LiteLLM 的差异取舍

| 取舍 | 理由 |
| --- | --- |
| 无 NER / 模型推理 | 三类实体是确定性结构；模型带来模型管理、延迟、误报调参成本，收益为零。需要自然人名/地址时再评估外挂 analyzer |
| 无上下文词加分（首版） | Presidio 的 LemmaContextAwareEnhancer 依赖 NLP 工程；三类实体已有校验码/结构强信号，加分边际收益小。路线图可加"关键词邻域"轻量版 |
| 单遍扫描、span 相对单条 content | 与 `ParsedLlmBody` 的 token 偏移对齐；不做跨消息关联（如"号码是" + 下一消息才给号） |
| 进程内检测，无独立 anonymizer 服务 | Presidio 的 analyzer/anonymizer 分离服务于 Python 生态复用；数据面内没有跨进程复用需求，去掉 HTTP 往返 |
| 自研引擎而非 RE2 依赖 | 三个固定模式；RE2+abseil 体量与编译成本不成比例。代价：失去 RE2 的长年 fuzz 与完备语法，用语法子集 + 47 例测试补偿，且引擎失败模式是 `compile` 报错（显式）而非运行时错误 |

## 9. 验证记录

- 构建：`cmake -S native -B native/build-pii -DCMAKE_BUILD_TYPE=Debug
  -DFIBER_BUILD_TESTS=ON -DAI_SERVER_AUDIT_TRANSPORT=FILE`（clang-20 + libc++），
  `cmake --build native/build-pii --target fiber_ai_server_tests`。
- `ctest -R "NfaRegex|PiiDetector"`：47/47 通过。
- 全量回归：192 项中 188 项通过（4 项为 fiber 上游测试目标的 NOT_BUILT 占位，
  与本变更无关）。
- 开发过程中被测试拦截的两个引擎缺陷：`thread_local` 线程表跨 `search` 调用残留
  导致的幽灵匹配（死循环）；`{n,}` 展开少算一份拷贝导致下界变 n−1。两者均有回归
  用例。
