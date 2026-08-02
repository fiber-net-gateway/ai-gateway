# Repository Guidelines

## Project Purpose

This repository is the management console for `fiber-gateway-cpp/apps/ai-server`. It is not a
general Nacos console or an end-user chat application. The product combines ai-server
documentation with safe configuration editing, draft and release workflows, runtime status, and
auditing.

Keep three states distinct in code and UI: a draft saved in MySQL, content published to rnacos, and
configuration proven active on ai-server instances. A successful rnacos write is not evidence that
every instance accepted the configuration.

## Project Structure & Module Organization

The repository is an npm workspaces project:

- `web/` contains the React and TypeScript frontend. `web/src/main.tsx` currently contains the
  migrated introduction page, and `web/src/styles.css` contains its visual system.
- `server/` contains the Node.js and TypeScript API. Keep the Fastify application in
  `server/src/app.ts` independently constructible for tests; `server/src/index.ts` is only the
  process entry point.
- `server/src/config/` owns environment parsing and validation.
- `server/src/database/` owns MySQL infrastructure. Add future migrations under
  `server/src/database/migrations/` and keep them deterministic and reviewable.
- Add backend domain modules under `server/src/modules/<domain>/`, with routes, services,
  repositories, schemas, and tests colocated when those modules are introduced.
- `.temp/fiber-gateway-cpp/` is an ignored local upstream checkout used only for source research.
  Never import from it or commit it.
- `web/dist/` and `server/dist/` are generated output. Do not edit or commit them.

As the frontend grows, extract reusable controls into `web/src/components/`, route-level screens
into `web/src/pages/`, API access into `web/src/api/`, and content constants into `web/src/data/`.
Store static assets under `web/public/`.

## Architecture Boundaries

- MySQL is the system of record for console environments, normalized resources, drafts, immutable
  releases, approvals, and audit events.
- rnacos is the Nacos-compatible configuration and naming service used by ai-server. Dynamic LLM
  configuration uses the fixed group `LLM-SERVER`; do not allow clients to supply arbitrary groups
  or Data IDs.
- ai-server remains the LLM proxy. The console backend manages configuration and observes health;
  it must not silently become a proxy for user LLM traffic.
- Keep infrastructure clients behind typed services so route handlers do not contain SQL, rnacos
  protocol details, or direct ai-server HTTP calls.
- Do not require external services for application construction or unit tests. Establish MySQL,
  rnacos, and ai-server connections during explicit lifecycle steps and close them on shutdown.

The main dynamic Data IDs are:

- `ploto.ai-llm.auth.bt1.keys`
- `ploto.ai-llm.models`
- `ploto.ai-llm.provider.<provider-name>`
- `ploto.ai-llm.user-group.<group-name>`

Provider tokens, BT1 secrets, MySQL passwords, and rnacos credentials must never be returned,
logged, or included in plaintext diffs. Model secret fields as write-only values and retain only
safe configured-state and fingerprint metadata for display.

## Build, Test, and Development Commands

Run commands from the repository root:

- `npm install` installs all workspace dependencies using the root lockfile.
- `npm run dev` starts both Vite and the API in watch mode.
- `npm run dev:web` starts only the frontend on all interfaces.
- `npm run dev:server` starts only the backend.
- `npm run typecheck` runs strict TypeScript validation for all workspaces.
- `npm test` runs backend tests.
- `npm run format` formats supported source and documentation files with Prettier.
- `npm run format:check` verifies formatting without changing files.
- `npm run build` builds both workspaces into their local `dist/` directories.

Before submitting changes, run:

```bash
npm run typecheck && npm test && npm run format:check && npm run build
```

## Coding Style & API Conventions

Use TypeScript with strict checks. Follow the repository Prettier configuration: two-space
indentation, single quotes, no semicolons, trailing commas, and a 100-character print width. Use
`PascalCase` for components and types, `camelCase` for functions and variables, and kebab-case for
CSS classes.

Use functional React components and data-driven rendering for repeated UI. Preserve accessible
labels, keyboard operation, responsive layouts, and reduced-motion behavior. Do not present color
as the only indication of environment risk or release status.

Backend routes live under `/api`. Give request and response bodies explicit TypeScript types and
Fastify schemas. Return stable machine-readable error codes and field paths for validation errors.
Parse environment variables only through `server/src/config/`; do not scatter `process.env` reads.
Do not log request bodies or secrets.

## Configuration and Release Rules

Validate configuration in three stages: individual fields, resource relationships, and the whole
environment dependency graph. Publishing is an explicit workflow and must create an immutable
release record before writing rnacos. Multiple Nacos Data IDs do not form a transaction, so record
per-resource write results and per-instance activation results. Rollback creates a new release from
historical content; it does not rewrite database history.

Use upstream ai-server behavior as the source of truth for field names, defaults, protocols,
dependency ordering, and readiness semantics. When changing a content claim or configuration
contract, cite the relevant upstream source path in the pull request.

## Testing Guidelines

Use Node's test runner and Fastify injection for backend HTTP tests. Unit tests must be deterministic
and must not depend on live MySQL, rnacos, ai-server, clocks, or public networks. Add explicit
integration tests for repositories and infrastructure adapters when those layers are implemented.

No browser test framework is configured yet. For frontend changes, manually verify desktop and
mobile layouts, navigation, form keyboard behavior, unsaved-change guards, error focus, secret
redaction, and release-state labels. Add frontend test tooling before relying on complex form or
state transitions without automated coverage.

## Commit & Pull Request Guidelines

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `chore:`. Keep commits
focused. Pull requests should explain user-visible and data-model changes, list validation commands,
link related issues, and include before/after screenshots for visual work. Highlight schema changes,
secret-handling changes, rnacos publication behavior, and content claims updated from upstream.
