# Repository Guidelines

## Project Purpose

This repository is the complete AI Gateway product. It owns both:

- the C++23 `ai-server` data plane under `native/ai-server/`; and
- the React/Fastify management control plane under `web/` and `server/`.

The data plane authenticates and proxies application LLM traffic, applies routing and distributed
rate limits, streams Provider responses, and emits metrics, traces, and audits. The control plane
manages users, tokens, Providers, models, access groups, drafts, releases, rnacos publication, and
call-history projections. The product is not a general Nacos console or an end-user chat
application.

Keep three configuration states distinct in code, APIs, metrics, and UI: a draft saved in MySQL,
content published to rnacos, and configuration proven active on specific `ai-server` instances. A
successful rnacos write is not evidence that every instance accepted the configuration.

## Source Ownership and Upstream Boundaries

- `native/ai-server/` is repository-owned application code. Its initial migration provenance is
  recorded in `native/ai-server/UPSTREAM.md`; new `ai-server` features and fixes are developed here.
- `fiber-gateway-cpp` remains the source of the reusable Fiber runtime, HTTP, Nacos, CAT, and
  Prometheus modules consumed by the native build at a pinned revision and archive hash.
- Do not build or import the upstream `fiber-gateway-cpp/apps/ai-server` copy. Synchronize code from
  it only when explicitly required, preserve `native/ai-server/LICENSE.upstream`, and document the
  source revision.
- `.temp/fiber-gateway-cpp/` is an ignored research checkout. Never import from it, edit it as part
  of this repository, or commit any of its contents.
- Keep compatibility patches under `native/patches/` narrow, reviewable, and tied to a pinned Fiber
  revision. Prefer upstream fixes, record the related upstream Issue or PR, and remove local patches
  once the pinned revision contains the fix.

## Project Structure and Module Organization

The repository combines npm workspaces with a native CMake project:

- `web/` contains the React, TypeScript, and Vite control-plane frontend. Put reusable controls in
  `web/src/components/`, route-level screens in `web/src/pages/`, API access in `web/src/api/`, and
  content constants in `web/src/data/`. Store static assets under `web/public/`.
- `server/` contains the Node.js and TypeScript control-plane API. Keep `server/src/app.ts`
  independently constructible for tests; `server/src/index.ts` is only the process entry point and
  explicit lifecycle owner.
- `server/src/config/` owns environment parsing and validation. Do not scatter `process.env` reads.
- `server/src/database/` owns MySQL infrastructure and deterministic migrations.
- `server/src/modules/<domain>/` owns domain routes, services, repositories, schemas, and colocated
  tests.
- `native/CMakeLists.txt` owns the top-level C++ build, pinned Fiber dependency, and compile-time
  audit transport selection.
- `native/ai-server/src/` contains the gateway runtime. Keep modules separated by responsibility:
  `audit/`, `auth/`, `config/`, `discovery/`, `limit/`, `observability/`, `protocol/`, `provider/`,
  `routing/`, and `server/`.
- `native/ai-server/tests/` contains GoogleTest coverage for the data plane. Add new test sources to
  `native/ai-server/CMakeLists.txt`.
- `deploy/`, the root `Dockerfile`, and `compose.yaml` define the end-to-end container stack.

`web/dist/`, `server/dist/`, `native/build*/`, `.temp/`, and local environment files are generated
or private output. Do not edit or commit them.

## Architecture Boundaries

- `native/ai-server` is the only component that proxies user LLM traffic. The Fastify control plane
  must not silently become an LLM proxy.
- The control plane is the configuration and workflow authority. `ai-server` must not read MySQL or
  control-plane tables directly; it consumes fixed rnacos configuration and uses discovered,
  authenticated internal HTTP endpoints for audit delivery.
- MySQL is the system of record for environments, users, normalized resources, drafts, immutable
  releases, approvals, publication evidence, and audit events.
- rnacos is the configuration and naming plane. Dynamic LLM configuration uses the fixed group
  `LLM-SERVER`; do not allow clients to supply arbitrary groups or Data IDs.
- Keep MySQL, rnacos, CAT, Provider, and `ai-server` clients behind typed services. Route handlers
  must not contain SQL, rnacos protocol details, or ad hoc data-plane calls.
- Application construction and deterministic unit tests must not require external services.
  Establish infrastructure connections during explicit lifecycle steps and close them on shutdown.
- The internal rate-limit check/settle endpoints, Prometheus endpoints, readiness endpoints, and
  demo Provider have no end-user authentication contract. Production deployments must isolate them
  with listener bindings, firewalls, a sidecar, or a service mesh.

The primary dynamic Data IDs are:

- `ploto.ai-llm.auth.bt1.keys`
- `ploto.ai-llm.models`
- `ploto.ai-llm.provider.<provider-name>`
- `ploto.ai-llm.user-group.<group-name>`

Provider tokens, BT1 secrets, MySQL passwords, rnacos credentials, audit ingest tokens, request
bodies, and response bodies must never be returned, logged, committed, or included in plaintext
diffs. Model secret fields as write-only values and retain only safe configured-state and
fingerprint metadata for display.

## Build, Test, and Development Commands

Run commands from the repository root.

Control plane:

- `npm install` installs all workspace dependencies using the root lockfile.
- `npm run dev` starts Vite and Fastify in watch mode.
- `npm run dev:web` or `npm run dev:server` starts one control-plane workspace.
- `npm run typecheck` runs strict TypeScript validation.
- `npm test` runs backend tests.
- `npm run format` formats supported web, server, and documentation files with Prettier.
- `npm run format:check` verifies Prettier formatting.
- `npm run build` builds both npm workspaces.

Native data plane:

- `npm run configure:native` configures a Release HTTP-audit build in `native/build/`.
- `npm run build:native` builds the `fiber_app_ai_server` target.
- `npm run test:native:http` builds and runs the HTTP-audit test set.
- `npm run test:native:file` builds and runs the FILE-audit test set.
- `npm run test:native` runs both compile-time audit variants.

Docker:

- `./scripts/init-demo-env.sh` creates the ignored mode-`0600` Compose environment.
- `docker compose --env-file .env.docker up --build` builds and starts the end-to-end gateway.
- `docker compose --env-file .env.docker config` validates Compose interpolation.

Before submitting control-plane or shared configuration changes, run:

```bash
npm run typecheck && npm test && npm run format:check && npm run build
```

Before submitting native changes, also run the relevant native build and both audit variants when
the change can affect shared sources, conditional compilation, configuration, or shutdown:

```bash
npm run test:native
```

For Docker changes, validate the rendered Compose configuration and perform targeted container
health and endpoint checks. Do not print the fully rendered configuration when it would expose
secrets.

## TypeScript, React, and API Conventions

Use TypeScript with strict checks. Follow the repository Prettier configuration: two-space
indentation, single quotes, no semicolons, trailing commas, and a 100-character print width. Use
`PascalCase` for components and types, `camelCase` for functions and variables, and kebab-case for
CSS classes.

Use functional React components and data-driven rendering for repeated UI. Preserve accessible
labels, keyboard operation, responsive layouts, and reduced-motion behavior. Do not present color
as the only indication of environment risk, publication status, or activation status.

Backend routes live under `/api`. Give request and response bodies explicit TypeScript types and
Fastify schemas. Return stable machine-readable error codes and field paths for validation errors.
Do not log request bodies, response bodies, authorization headers, cookies, or secrets.

## C++23 and CMake Conventions

Follow the migrated Fiber C++ conventions in `native/ai-server/`:

- Use C++23, four-space indentation, braces on the same line, and namespaces under
  `fiber::ai_server` or the relevant `fiber::...` module.
- Use PascalCase for classes and types. Follow the existing snake_case convention for functions,
  methods, and variables. Header guards use `FIBER_AI_SERVER_<NAME>_H`.
- Keep includes explicit and local. Keep focused headers and `.cpp` implementations together by
  module; do not create broad convenience headers.
- Do not use C++ exceptions or write `throw`. Prefer `noexcept` for callback-style and internal
  functions whose contract is non-throwing, and propagate expected failures through the existing
  result/status types.
- Establish required invariants during construction or initialization and assert them there.
  Avoid nullable steady-state members and repeated defensive null checks in hot paths.
- In EventLoop request paths, use `fiber::event::EventLoop::current().now()` instead of performing
  independent system-clock reads.
- Never block an EventLoop on MySQL, rnacos, audit delivery, DNS, or another HTTP service. Preserve
  the existing ownership, backpressure, cancellation, and ordered-shutdown models.

The data plane is performance-first. Minimize allocation and release churn in request, streaming,
JSON parsing, routing, rate-limit, metric, and tracing hot paths. Do not introduce allocation-heavy
`std::string`, `std::vector`, `std::function`, shared ownership, or repeated JSON materialization by
default. Use them only with a clear lifetime and non-hot-path justification; prefer reusable
buffers, fixed-size structures, views, intrusive/custom ownership, and compile-time callables.

Keep CMake target dependencies explicit. Add new application sources and tests to
`native/ai-server/CMakeLists.txt`; do not glob source files. Do not change the pinned Fiber revision
or archive hash without reviewing upstream changes, revalidating local patches, and running the
native test matrix. `AI_SERVER_AUDIT_TRANSPORT` selects exactly one implementation at compile time;
do not make FILE and HTTP audit delivery active simultaneously.

## Database Query Rules

Server runtime SQL must be strict, parameterized, single-table SQL: each statement may read or
write only one physical table. Do not use `JOIN`, subqueries (including correlated subqueries and
`INSERT ... SELECT`), CTEs, `UNION`/`INTERSECT`/`EXCEPT`, window functions, or complex database-side
aggregation. Do not hide these constructs behind views, stored procedures, triggers, or dynamic SQL.

Load related rows with separate repository calls and assemble relationships in TypeScript with
typed maps. Use single-table read projections or explicitly maintained counters for list summaries,
and use `LIMIT pageSize + 1` instead of a separate `COUNT(*)` for cursor pagination. Multi-table
business changes may use a transaction, but it must execute a stable sequence of simple
single-table statements. Keep runtime SQL in repositories and add tests that enforce these rules.

## Configuration and Release Rules

Validate configuration in three stages: individual fields, resource relationships, and the whole
environment dependency graph. Use the repository-owned `native/ai-server` behavior as the source of
truth for field names, defaults, protocols, dependency ordering, and readiness semantics.

Publishing is an explicit workflow and must create an immutable release record before writing
rnacos. Multiple Data IDs do not form a transaction, so record per-resource write results and
per-instance activation results separately. Rollback creates a new release from historical content;
it does not rewrite database history. Never label a release active based only on successful rnacos
publication or MD5 readback.

## Testing Guidelines

Use Node's test runner and Fastify injection for backend HTTP tests. Unit tests must be deterministic
and must not depend on live MySQL, rnacos, `ai-server`, clocks, or public networks. Add explicit
integration tests for repositories and infrastructure adapters when those layers are implemented.

Native tests use GoogleTest and CTest. Put application tests under `native/ai-server/tests/`, name
files `*Test.cpp`, keep each test focused on one behavior, and register sources in
`native/ai-server/CMakeLists.txt`. Exercise both `HTTP` and `FILE` audit builds when shared code or
conditional compilation changes. Tests must not require live rnacos, CAT, Providers, or public
networks; use local deterministic fakes and loopback integration servers.

Preserve readiness semantics in tests: liveness proves that the process is running, readiness
proves that a complete configuration snapshot and rate-limit membership are installed, and neither
alone proves that a particular release is active on every instance.

No browser test framework is configured yet. For frontend changes, manually verify desktop and
mobile layouts, navigation, keyboard behavior, unsaved-change guards, error focus, secret
redaction, and draft/published/active labels. Add frontend test tooling before relying on complex
form or state transitions without automated coverage.

## Commit and Pull Request Guidelines

Use Conventional Commits in the form `type(scope): subject` where a useful scope exists. Preferred
types are `feat`, `fix`, `refactor`, `perf`, `test`, `build`, `docs`, and `chore`. Keep scopes aligned
with components such as `web`, `server`, `ai-server`, `rnacos`, `audit`, `config`, `json`, `build`,
or `docker`. Add a `BREAKING CHANGE:` footer when required.

Keep commits focused. Pull requests should explain user-visible, protocol, performance, and data
model changes; link related Issues; and list exact validation commands. Include before/after
screenshots for visual changes. Highlight schema changes, secret handling, rnacos publication,
runtime activation evidence, audit transport, hot-path allocation, shutdown behavior, pinned Fiber
revision changes, and any local compatibility patch added or removed.
