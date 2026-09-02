# AGENTS.md

Single source of truth for ALL agents (Claude, Codex, Copilot, Cursor, Gemini).

## Purpose
Fork of Wiki.js (AGPL-3.0) + Couchbase-specific extensions. Keep custom code isolated.

## Repo map
- `client/` — Vue 2 + Vuetify 2 + Apollo. `.vue` SFCs. New components → `client/components/`.
- `server/` — Node backend. Objection.js (Knex ORM).
- `server/graph/schemas/` — GraphQL SDL. `server/graph/resolvers/` — resolvers.
- `server/modules/rendering/` — custom markdown renderers (registered as modules). New renderer → here, follow existing module pattern.
- `server/modules/authentication/` — Passport.js auth strategies. New auth module → here.
- `server/modules/search/couchbase/` — Couchbase FTS search engine. Owns its scope-level index (`index-definition.json`, upserted on `init()`). Pure logic in `helpers.js` (unit-tested), SDK IO in `engine.js`. Bucket/scope/collection provisioned outside this repo: ps-knowledge-hub terraform for Capella, `couchbase-init` compose service locally.
- `server/db/migrations/` — DB migrations (irreversible once run).
- `server/middlewares/` — auth/permission middleware.
- `patches/` — patch-package patches. `server/test/` — tests. `.npmrc` — `save-exact = true`.
- `@couchbaselabs/topology-ui` — custom Couchbase package, topology diagram rendering.

## Run / build / test
- `yarn install` — install deps (runs `patch-package` postinstall).
- `yarn dev` — dev server, HMR (webpack dev middleware + Node server, port 3000).
- `yarn build` — prod webpack build.
- `yarn watch` — webpack watch, client only, no server restart.
- `yarn test` — ESLint + pug-lint + Jest (full suite).
- `node server` — prod server (needs built assets + `config.yml`).

## Conventions
- Node ≥20. Use `yarn` not `npm`. Lock = `yarn.lock`. Pin exact versions, no `^`.
- `NODE_OPTIONS=--openssl-legacy-provider` required for webpack cmds (set via `cross-env` in scripts).
- No TypeScript — plain JS (babel-eslint, ES2017+).
- ESLint: `eslint-config-requarks` + `plugin:vue/strongly-recommended`. No overrides without reason.
- Pug: 2-space indent, single-quote attrs, `validateDivTags` enforced (`pugLintConfig` in `package.json`).
- GraphQL queries inline via `graphql-tag` babel plugin (tag: `gql`).
- Stack: Vue 2 + Vuex + Vue Router + Apollo Client. NOT Vue 3 — no Vue 3 APIs.
- GraphQL subscriptions via `subscriptions-transport-ws`, NOT `graphql-ws`.
- `couchbase@4.7.1` is a native addon (prebuilt binaries per platform). Image builds must fetch or build a binary matching the target arch.
- Commits: gitmoji — `<emoji>(<scope>) #<issue>: <message>`. Scope + `#issue` optional. No Co-Authored-By trailer.
- After client change: `yarn build` or verify via `yarn dev` before done.
- After server change: `yarn test` before done.

## Gotchas
- Never commit `config.yml` (sensitive). Only `config.sample.yml` tracked.
- PRs ALWAYS target `couchbase-ps/wiki` (fork), NEVER `requarks/wiki` (upstream). Use `gh pr create --repo couchbase-ps/wiki` or set `gh repo set-default couchbase-ps/wiki`.
- Keep context lean: read only files relevant to current feature area.
- On compact: preserve modified file list, commands run, test output, migration state.

## Agent rules — stop conditions (ask first)
- Ask before touching `server/db/migrations/` — irreversible once run.
- Ask before breaking changes to `server/graph/schemas/` — affects all clients.
- Do NOT modify `patches/` without understanding patched package behavior.
- Ask before changing auth/permission middleware (`server/middlewares/`).
- `yarn.lock` changes from `yarn upgrade` need explicit user approval.
- NEVER `git push`/`--force`/`--force-with-lease` without explicit permission. Local commit OK. Ask before push, every time.

## Working principles (Karpathy)

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**
When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution
**Define success criteria. Loop until verified.**
Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
