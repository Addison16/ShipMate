# Contributing to Shipmate

Thanks for helping. A few ground rules keep the project healthy.

## Before you start

- Check [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the roadmap and the decisions already made.
- Open an issue for anything bigger than a bug fix so we can agree on the shape first.

## Working on code

- Node 22 and pnpm (`corepack enable`). `pnpm install`, then `pnpm dev`.
- CI runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Run them before pushing.
- Server integration tests need Postgres and run only when `TEST_DATABASE_URL` is set. They wipe
  that database, so point it at a scratch one (e.g. `createdb shipmate_test`), never your dev data.
- Keep changes small and focused. One PR per concern.
- Schema changes go through `pnpm db:generate` so a migration is committed with them.

## Contributor License Agreement

Shipmate is licensed under the PolyForm Noncommercial License 1.0.0. So that the project can
keep that license, grant commercial licenses, or move to a different license later, every
contributor agrees to the [CLA](CLA.md) by adding this line to each commit:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. Commits without it will not be merged.
