# Fiber AI Server Console

English | [简体中文](README.zh-CN.md)

This repository contains the management console for `ai-server` in
[`fiber-gateway-cpp`](https://github.com/fiber-net-gateway/fiber-gateway-cpp). It is designed for
platform administrators and operators, not as an end-user LLM chat interface.

The console is intended to provide:

- Documentation for `ai-server` capabilities, protocols, routing, and configuration models.
- Structured configuration for models, providers, user groups, and BT1 keys.
- Draft, validation, approval, release, rollback, and audit workflows.
- Separate visibility into rnacos write status and configuration activation on `ai-server`
  instances.
- Bootstrap configuration templates, instance health, service discovery, and configuration
  snapshot status.

The console currently implements user and token management, separate Provider and model
maintenance, model-owned access groups and approval, immutable environment releases, recoverable
Provider-to-models publication, BT1 Key Ring publication, rnacos MD5 readback, environment
switching, an LLM call-audit ingest endpoint, and personal call history. The Docker demo adds
direct asynchronous audit delivery from `ai-server` and a deterministic Provider/model/release bootstrap. Instance
health and activation observation, NamingService observation, release approval/rejection/cancel,
and operator-driven rollback remain future work; activation is therefore reported as unknown.

## Architecture

```mermaid
flowchart LR
    B[Browser] --> W[console container<br/>Nginx + React]
    W -->|localhost /api| A[Fastify in the same container]
    A -->|MySQL mode<br/>domain data, drafts, releases, audits| D[(MySQL)]
    A -->|fixed Data IDs<br/>publish and MD5 readback| C[rnacos<br/>ConfigService]
    C -->|dynamic configuration subscription| S[ai-server]
    S -->|registration and discovery| N[rnacos<br/>NamingService]
    A -->|register fixed console API service| N
    N -->|discover healthy console API endpoints| S
    S -->|bounded asynchronous audit batches| A
    A -.->|health, readiness, and activation<br/>observer pending| S
    A -.->|instance observation pending| N
```

- `web/`: A React, TypeScript, and Vite frontend. In development, it proxies `/api` to the local
  backend.
- `server/`: A Fastify API. In MySQL mode, it uses `mysql2` and enables the rnacos configuration
  publisher. The default memory mode uses in-process stores and does not publish to rnacos.
- MySQL: Stores environment metadata, users and sessions, normalized configuration, drafts,
  immutable release records, access requests, and audit data.
- rnacos ConfigService: Receives only the fixed `LLM-SERVER` Data IDs published by the console;
  `ai-server` subscribes to those dynamic configurations.
- rnacos NamingService: Supports `ai-server` registration and service discovery. The console API
  registers the fixed `AI-GATEWAY@@ai-server-console-api` service; HTTP-audit builds of `ai-server`
  subscribe to it. Instance-state collection is still pending.
- `ai-server`: Remains the LLM proxy. It exposes health and readiness probes, but it does not yet
  provide the console with evidence that a specific release or Data ID MD5 is active.
- Call audits: The console ingest endpoint and per-user projection are implemented. In the default
  `HTTP` build, `ai-server` creates only the minimized projection and submits it through a bounded
  background queue. A `FILE` build retains the original full NDJSON audit behavior.

Solid arrows show currently implemented console integrations or existing runtime relationships.
Dashed arrows show integrations whose receiving contract or configuration may exist but whose
end-to-end runtime path is not yet implemented.

Dynamic configuration always uses the rnacos group `LLM-SERVER`. Its primary Data IDs are:

- `ploto.ai-llm.auth.bt1.keys`
- `ploto.ai-llm.models`
- `ploto.ai-llm.provider.<provider-name>`
- `ploto.ai-llm.user-group.<group-name>`

A successful rnacos write proves only that content was published. It does not prove that every
`ai-server` instance activated the configuration. The release center reports draft state and
rnacos write results separately and keeps activation `UNKNOWN` until instance evidence exists.

## Project Structure

```text
.
├── web/                    # React management console
│   ├── src/
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── server/                 # Node.js + TypeScript API
│   ├── src/
│   │   ├── config/         # Environment variable parsing
│   │   ├── database/       # MySQL connection and deterministic migrations
│   │   ├── modules/        # Users, marketplace, access, rnacos, and call audits
│   │   ├── app.ts          # Fastify application and route registration
│   │   └── index.ts        # Process entry point
│   └── .env.example
├── native/                 # Repository-owned ai-server source and pinned CMake integration
├── deploy/                 # Nginx, ai-server, MySQL/CAT image inputs
├── scripts/                # Local demo credential initialization
├── compose.yaml            # Reproducible end-to-end demonstration stack
├── .temp/fiber-gateway-cpp # Local upstream checkout used only for source research
└── package.json            # npm workspaces and repository-wide commands
```

`.temp/` and all `dist/` directories are ignored. Application code must not import from them, and
they must not be committed.

## Local Development

Node.js 20 or later is required. Install dependencies and create a local environment file:

```bash
npm install
cp server/.env.example server/.env
```

The default `APP_DATA_MODE=memory` supports local evaluation without external services. Its data is
cleared when the process exits. Sign in with the initial administrator account, `admin`. Start the
frontend and backend together:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`

You can also start each workspace separately:

```bash
npm run dev:web
npm run dev:server
```

Check local connectivity through the health endpoint:

```bash
curl http://localhost:3000/api/hello
```

Response:

```json
{
  "message": "Hello World!",
  "service": "ai-server-console-api"
}
```

This endpoint does not require MySQL, rnacos, or `ai-server`, so it can be used to verify the local
frontend-to-backend path.

## Docker Demonstration

Docker Compose starts MySQL, rnacos, CAT, one combined console container, `ai-server`, a local
OpenAI-compatible demo Provider, and a one-shot configuration bootstrap. The first `ai-server`
image build compiles the repository-owned application against pinned Fiber modules and can take
several minutes.

Generate untracked credentials, then build and start the stack. Services are loopback-only by
default. To access them from a trusted LAN, provide the shared bind address and this machine's LAN
address while generating the environment file:

```bash
DEMO_BIND_ADDRESS=0.0.0.0 CONSOLE_PUBLIC_HOST=172.23.222.82 ./scripts/init-demo-env.sh
docker compose --env-file .env.docker up --build
```

Open:

- Console: `http://172.23.222.82:5173`; sign in as `admin`.
- `ai-server`: `http://172.23.222.82:8080`; `/ready` becomes successful after it accepts the rnacos
  snapshot.
- Demo Provider: `http://172.23.222.82:8081/health`.
- CAT: `http://172.23.222.82:8082/cat/r`.
- rnacos API: `http://172.23.222.82:8848`.
- rnacos console: `http://172.23.222.82:10848/rnacos/`; its generated login is stored only in
  `.env.docker`.

The bootstrap publishes the BT1 Key Ring and a `fiber-demo` model routed to the local Provider.
Create a BT1 token in the console, then call the real proxy:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <BT1 token>' \
  -d '{"model":"fiber-demo","messages":[{"role":"user","content":"hello"}]}'
```

The call appears in CAT and in the signed-in user's call history after `ai-server` submits the
minimized audit record. A healthy `/ready` endpoint is runtime evidence for this demo instance, but
the console deliberately keeps Release activation `UNKNOWN` until a typed per-instance activation
observer is implemented.

LAN publishing exposes the console, `ai-server`, demo Provider, CAT, and rnacos. MySQL always
remains bound to loopback. The demo includes passwordless development authentication and testing
endpoints, so it must be exposed only on a trusted network. Use production authentication and a
firewall on shared or untrusted networks.

Stop the stack with `docker compose --env-file .env.docker down`. Add `--volumes` only when you
intend to delete all demo MySQL, rnacos, and audit data. The generated environment file is mode
`0600` and ignored by Git; do not reuse these demonstration credentials in a shared deployment.

### Using MySQL

Create the database and a least-privilege account, then configure `server/.env`:

```dotenv
APP_DATA_MODE=mysql
MYSQL_HOST=127.0.0.1
MYSQL_USER=ai_server_console
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=ai_server_console
```

At startup, the backend automatically applies pending migrations from
`server/src/database/migrations/`. Production mode (`NODE_ENV=production`) requires MySQL and an
explicit, randomly generated `APP_ENCRYPTION_KEY`.

## Configuration

After copying `server/.env.example`, configure these connections and settings as needed:

- `MYSQL_*`: Console database settings.
- `RNACOS_*`: rnacos address, bound environment, namespace, tenant, credentials, fixed
  configuration group, and optional console API service registration.
- `AI_SERVER_BASE_URL`: Reserved target address for a future `ai-server` status client. It is
  validated at startup but the current backend does not call it.
- `AUDIT_INGEST_TOKEN` and `AUDIT_INGEST_BODY_LIMIT_BYTES`: Optional Bearer credential and body
  limit for the console's internal call-audit ingest endpoint. An empty token disables ingestion;
  Compose supplies the same generated value to `ai-server`.
- `AUTH_MODE` and `OIDC_*`: Local development authentication or enterprise OIDC with PKCE.
- `APP_ENCRYPTION_KEY`: Encryption key for short-lived token delivery and local secret wrapping.
- `BOOTSTRAP_*`: Initial administrator, environment, and BT1 signing key settings.
- `APP_HOST`, `APP_PORT`, and `APP_PUBLIC_URL`: Console listener and browser-facing URL settings.

Do not commit `server/.env`. MySQL passwords, rnacos passwords, provider tokens, BT1 secrets, and
the audit-ingest token must never be exposed in logs, API responses, or audit diffs. See
[`docs/llm-call-audit-requirements.md`](docs/llm-call-audit-requirements.md) for the minimized
per-user call-history contract.

## Validation and Build

Run these commands from the repository root:

```bash
npm run typecheck
npm test
npm run format:check
npm run build
npm run configure:native
npm run build:native
npm run test:native
```

Build output is generated in `web/dist/` and `server/dist/`. The root `Dockerfile` provides
`server`, `tools`, and `console` targets; the console target runs Nginx and Fastify together.
Native builds default to `-DAI_SERVER_AUDIT_TRANSPORT=HTTP`; configure with `FILE` to retain
NDJSON audit files instead of HTTP delivery.

## Upstream References

The console domain model follows the current implementation in
`fiber-gateway-cpp/apps/ai-server`, together with `docs/product-requirements.md` and
`docs/user-module-design.md`. Update the local research checkout with:

```bash
git -C .temp/fiber-gateway-cpp pull --ff-only
```

Upstream repository: <https://github.com/fiber-net-gateway/fiber-gateway-cpp>
