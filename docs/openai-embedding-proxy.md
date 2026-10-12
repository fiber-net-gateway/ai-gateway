# OpenAI Embeddings proxy

`ai-server` accepts authenticated `POST /v1/embeddings` requests and routes them to
Providers declaring `openai-embedding`. The management API uses `OPENAI_EMBEDDING`;
metrics and audit events use `openai-embedding`.

## Request and response contract

- Clients send a logical `model` and `input` as a nonempty string, an array of
  nonempty strings, a nonempty array of nonnegative integer token IDs, or an array
  of nonempty token arrays. A batch contains at most 2048 inputs. The batch limit
  does not apply to the length of one token sequence.
- `dimensions` is a positive integer; `encoding_format` is `float` or `base64`;
  `user` is a string. `stream`, including `stream: false`, is rejected. Critical
  duplicate fields, including escaped duplicate names, are rejected.
- The gateway validates structure; the Provider validates tokenizer vocabulary,
  model capabilities and exact token limits. `user` never replaces the BT1 identity.
- Only `model` is rewritten. Other request fields retain their original JSON bytes.
  Unknown extensions pass through. Request size is limited to 4 MiB, root fields
  to 4096, and extension nesting to 64 containers.
- Responses are buffered up to 32 MiB. The gateway scans vectors without building
  a DOM or vector arrays, verifies item count, unique in-range indexes, encoding,
  and consistent dimensions, then returns original bytes. Base64 is checked for
  canonical encoding and float32 byte length without decoding the vector. The
  response retains the Provider's model name.
- Large batches can exceed the gateway response limit even if the Provider accepts
  the input. Clients must reduce the batch size; the gateway does not automatically
  split, truncate, normalize or cache vectors.

See the [official OpenAI API contract](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

## Routing, retries and accounting

Only embedding-capable Providers participate. Active primary and fallback mappings
must use the same upstream model name. Both publication graph validation and the
native execution planner enforce this rule, including temporarily unavailable
candidates. Disabled fallback mappings are excluded from this compatibility check.
Matching names alone do not prove equal model versions, vector spaces or tokenizers:
operators must verify those before enabling multiple candidates. Changing an alias
to a different vector space also requires rebuilding affected application indexes.

The existing principal/model route key, connection and credential pools, bounded
retry policy and distributed limiter are reused. There is no prompt-affinity hash
of input vectors or text. Normal parameter errors, invalid successful responses and
response-size violations are not automatically replayed. Transport failure retries
can still repeat upstream computation and incur additional Provider charges.

Valid nonnegative `prompt_tokens` and `total_tokens` must agree. They map to
`in_nocache=prompt_tokens`, `in_cache=0`, `out=0`; the total is not added twice.
Missing or invalid usage leaves consumption unknown, preserves a valid response and
releases the limiter ticket without inventing a zero-token measurement. The fixed
`ai_server_embedding_usage_total{result="known|unknown"}` series expose this condition.
The existing check-then-settle limiter does not reserve tokens before execution, so
concurrent batches can overshoot a window. This is not a strict prepaid quota.

HTTP and FILE audits retain metadata and usage, never input texts, token sequences
or vector bodies. HTTP audit schema remains v6. There is no time-to-first-token
measurement for embeddings. Disconnects during buffered collection retain the
existing bounded upstream collection and settlement lifecycle.

## Management and deployment

Migration `010-openai-embedding-protocol` extends the Provider protocol CHECK and
adds `embedding_coverage`, defaulting historical projections to `UNSUPPORTED`.
Runtime SQL remains parameterized and single-table. Subsequent projection refreshes
populate the new column. Existing draft/release formats and fixed `LLM-SERVER` Data
IDs remain unchanged. Pure embedding models are valid without generation protocols.

1. Apply the additive database migration and deploy compatible control-plane code.
2. Upgrade every data-plane instance receiving embedding traffic before publishing
   embedding model configurations. Older instances may parse the configuration but
   cannot serve the endpoint; readiness is not a feature-capability probe.
3. Configure the Provider path, upstream model and credentials; bind it to a logical
   model, verify vector compatibility, and publish through the existing release flow.
4. Verify routing and per-instance activation separately from rnacos write/readback.
   Rollback creates a new release; do not mutate historical release content.

Do not run an older control plane over newly created embedding configuration. Before
rolling application binaries back, publish a compatible historical configuration
with the upgraded control plane. The additive database migration need not be removed.

## Validation

Native protocol and loopback integration tests cover all input shapes, raw model
rewrites, float/base64 output, shape and usage failures, retry/settlement behavior,
body limits, protocol isolation and audit minimization in HTTP and FILE builds.
They also cover parser limits, retry exhaustion, concurrent large responses,
downstream disconnects, and a listener stop during buffered collection. The stop
fixture shares its listener with the fake limiter: it verifies that unavailable
settlement delivery reports one failure while retaining known usage, rather than
claiming that the remote ticket was settled.
Control-plane tests cover protocol admission/filtering, deterministic rendering,
embedding-only coverage, incompatible candidates and the migration contract.

Run the repository checks:

```sh
npm run typecheck
npm test
npm run format:check
npm run build
./format_code.sh
npm run test:native
git diff --check
```

Live MySQL migration and external Provider/SDK interoperability require separate
integration validation. Unit tests do not establish per-instance runtime activation.
Local browser checks cover desktop/mobile protocol editing, keyboard toggles,
model filtering, the embedding-only call example, and call-history filtering.
The existing Provider editor does not guard unsaved navigation or focus invalid
fields; these remain frontend limitations.
