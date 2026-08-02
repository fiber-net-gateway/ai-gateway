# Repository Guidelines

## Project Structure & Module Organization

This repository is a React and TypeScript static introduction site for [fiber-gateway-cpp](https://github.com/fiber-net-gateway/fiber-gateway-cpp).

- `src/main.tsx` contains the page structure, content data, and interactive components.
- `src/styles.css` contains the responsive layout, visual system, and animations.
- `index.html` provides metadata and the Vite entry point.
- `vite.config.ts` and `tsconfig.json` define build and TypeScript behavior.
- `.temp/fiber-gateway-cpp/` is an ignored local checkout used only for source research. Never import from or commit this directory.
- `dist/` is generated output and must not be edited or committed.

Keep new UI components in `src/`. If the page grows, extract reusable components into `src/components/` and content constants into `src/data/`. Store future static assets under `public/`.

## Build, Test, and Development Commands

- `npm install` installs the locked dependencies.
- `npm run dev` starts the Vite development server on all interfaces.
- `npm run typecheck` runs strict TypeScript validation without emitting files.
- `npm run format` formats supported source and documentation files with Prettier.
- `npm run format:check` verifies formatting without changing files.
- `npm run build` creates the production site in `dist/`.
- `npm run preview` serves the production build locally.

Before submitting changes, run `npm run typecheck && npm run format:check && npm run build`.

## Coding Style & Naming Conventions

Use TypeScript and functional React components. Follow the repository Prettier configuration: two-space indentation, single quotes, no semicolons, trailing commas, and a 100-character print width. Use `PascalCase` for components and types, `camelCase` for functions and variables, and kebab-case for CSS class names. Prefer data-driven rendering for repeated cards, modules, or application details. Preserve accessible labels, keyboard-friendly controls, and reduced-motion behavior.

## Testing Guidelines

No automated browser test framework or coverage threshold is configured yet. Treat TypeScript checks and production builds as required baseline validation. For visual changes, manually verify desktop and mobile layouts, navigation, application tabs, copy actions, and external GitHub links. Add tests alongside any future test tooling using descriptive names such as `ApplicationPanel.test.tsx`.

## Commit & Pull Request Guidelines

History follows Conventional Commit style, for example `feat: initialize Fiber Gateway introduction site`. Use concise prefixes such as `feat:`, `fix:`, `docs:`, or `chore:` and keep each commit focused. Pull requests should explain the user-visible change, list validation commands, link related issues, and include before/after screenshots for visual work. Call out content claims that were updated from the upstream gateway source.
