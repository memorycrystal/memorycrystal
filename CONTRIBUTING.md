# Contributing

Thanks for your interest in Memory Crystal! Here's how to contribute.

## Getting Started

1. Fork the repo and create a feature branch from `main`
2. Install dependencies: `npm install`
3. Start the Convex dev backend: `npx convex dev`
4. Start the web app: `npm run dev`
5. Build the MCP server: `cd mcp-server && npm run build`

## Monorepo Layout

| Directory | What | Stack |
|---|---|---|
| `apps/web/` | SaaS dashboard | Next.js 15, React 19, Tailwind 4 |
| `convex/` | Backend functions | Convex (schema, mutations, queries, crons) |
| `mcp-server/` | MCP server (npm package, stdio + SSE) | TypeScript, @modelcontextprotocol/sdk |
| `packages/mcp-server/` | MCP server (HTTP transport) | TypeScript |
| `plugin/` | OpenClaw hooks | Plain JS |

## Before Submitting a PR

- `npx vitest run` must pass (Convex backend tests)
- `npm run test:smoke` must pass (integration smoke tests)
- `cd mcp-server && npm run build` must succeed
- `cd apps/web && npm run lint` must pass

## Code Style

- TypeScript strict mode — avoid `any` where possible
- Follow existing patterns in each package
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

## Pull Request Workflow

1. Fork and branch from `main`
2. Make your changes with clear, focused commits
3. Ensure all checks above pass
4. Open a PR against `main` with a description of what and why
5. Production deployment configuration in `package.json` is for maintainers only

## License

MIT — see [LICENSE](LICENSE).
