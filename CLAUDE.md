# Clay CMS

Headless CMS integration for Astro. Adapter-based: any Drizzle-supported database, any blob store. The first shipped adapters target Cloudflare D1 and R2, and the playground demonstrates that combination, but the core has no hard Cloudflare dependency. Inspired by Payload CMS's collection-based API and config-file convention, and Astro's integration patterns.

## Architecture

```
clay-cms              ← Core: types, fields.*, defineConfig, resolve, validate, auth, actions, admin pages, local API, integration
@clay-cms/drizzle     ← Shared: buildSchema(), createCrud() — dialect-agnostic
  ^
  |
@clay-cms/db-d1       ← First DB adapter (D1): sqliteTable + drizzle-orm/d1 + DrizzleAccessor
@clay-cms/storage-r2  ← First storage adapter (R2): file upload/serve via R2 bindings

playground/           ← Astro 6 + Cloudflare adapter demo (one possible deployment target)
```

- **Adapter pattern**: `DatabaseAdapterResult` / `StorageAdapterResult` are factories. `init()` receives resolved collections and returns the adapter instance. DB adapters expose `drizzle?: DrizzleAccessor`, `drizzleModuleCode`, and `generateInitSQL` for auto-table-creation. `DrizzleAccessor.schemaConfig` carries the dialect-specific `SchemaBuilderConfig` (table factory + semantic column builders) so `runtime/api.ts` stays dialect-agnostic — the adapter ecosystem is the dialect registry, no hardcoded provider switch.
- **Collection system**: plain `CollectionConfig` objects + `fields.*` API. `resolveCollections()` merges system/upload/auth fields. `validateCollections()` runs boot-time checks.
- **Schema layer**: `@clay-cms/drizzle` is dialect-agnostic — it takes a `tableFactory` + `columns` config so it works with any Drizzle dialect, not just SQLite. Also provides `generateCreateStatements()` for DDL generation. Generates `_sessions` system table when auth collections exist.
- **Semantic column vocabulary**: `ColumnBuilders` exposes five builders — `text`, `integer`, `boolean`, `timestamp`, `json`. `(name) => ColumnBuilder`, no options bag. `schema.ts` only calls these; dialect-specific knobs (`{ mode: "boolean" }`, `{ mode: "json" }`) live in the adapter. JS-shape contract: `text`→`string`, `integer`→`number`, `boolean`→`boolean`, `timestamp`→ISO-8601 **string** (not `Date`), `json`→parsed JS value. D1 lowers `boolean`→`integer({mode:"boolean"})`, `timestamp`→`text`, `json`→`text({mode:"json"})`.
- **Auth**: collection-level (`auth: true`), no external library — `bcryptjs` + session tokens in `_sessions`. Auth logic in `packages/clay-cms/src/auth/` (shipped as source).
- **Local API**: see Local API + Access Control sections below.

## Integration entry & config-file convention (Payload-style)

The integration is **zero-arg** in `astro.config.mjs`. All CMS config lives in a separate `clay.config.ts` at the project root, discovered automatically by the integration via `jiti`.

```ts
// astro.config.mjs
import clay from "clay-cms";
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [clay()],   // auto-discovers ./clay.config.ts
});
```

```ts
// clay.config.ts — single source of truth
import { defineConfig, fields } from "clay-cms/config";
import { d1 } from "@clay-cms/db-d1";
import { r2 } from "@clay-cms/storage-r2";
import { posts } from "./src/collections/posts.ts";
import { users } from "./src/collections/users.ts";

export default defineConfig({
  db: d1({ binding: "CLAY_DB" }),
  storage: r2({ binding: "CLAY_BUCKET" }),
  collections: [posts, users],
  admin: { user: users.slug },
  localization: { locales: ["en", "fr"], defaultLocale: "en" },
});
```

Discovery order: `clay.config.ts` → `clay.config.mjs` → `clay.config.js`. Override via `clay({ configPath: "..." })`.

## Integration internals (handlers/)

`integration.ts` is a thin coordinator (~94 lines). Each cross-cutting concern lives in its own handler under `src/handlers/`:

```
src/
  integration.ts                ← coordinator: load config, sequence handlers
  handlers/
    load-config.ts              ← jiti-based clay.config.ts loader
    vite.ts                     ← Tailwind v4 + drizzle alias
    virtuals.ts                 ← single addVirtualImports call (uses builder)
    routes.ts                   ← injectRoute + addMiddleware
    types.ts                    ← injectTypes + .d.ts content
    logging.ts                  ← astro:server:setup banner + db.init
    virtual-builder.ts          ← VirtualBuilder factory (json/reexport/raw)
  runtime/
    api.ts                      ← cms proxy (shipped as source)
    init-sql.ts                 ← ensureTables (shipped as source)
```

Handlers are plain functions taking `(params, ctx)` rather than `defineUtility` wrappers — keeps types simple under `exactOptionalPropertyTypes`. The `astro:config:setup` hook is async because it awaits `loadClayConfig`. Shared state (`userConfig`, `resolved`) lives in a closure populated by `config:setup` and reused by `config:done` + `server:setup`.

## Conventions

- **`Astro.locals` namespace**: all keys Clay assigns to `Astro.locals` are prefixed `clay*` to avoid clashing with consumer apps — `clayUser`, `claySession`. (No `clayCms` wrapper — there's a single `cms` import; consumers thread `user: Astro.locals.clayUser` explicitly.)
- **ESM only**, no CJS. All packages use `"type": "module"`.
- **tsup** for all builds. Entry pattern: `src/**/*.(ts|js)` (excluding `*.spec.ts`). Peer + regular deps are externalized.
- **Biome** for linting/formatting (not ESLint/Prettier). Run `pnpm lint:fix` to auto-fix.
- **pnpm workspaces**. Use `workspace:*` for inter-package deps.
- Prefer **tabs** for indentation (Biome default).

## TypeScript

- `clay-cms` extends `astro/tsconfigs/strictest` — this enables `exactOptionalPropertyTypes: true`.
- You CANNOT assign `T | undefined` to optional props. Use conditional assignment:
  ```ts
  // WRONG: labels: collection.labels,
  // RIGHT:
  if (collection.labels) { resolved.labels = collection.labels; }
  ```
- Other packages use a simpler strict tsconfig without Astro's extras.
- tsup handles JSON imports (`import { peerDependencies } from "./package.json"`) fine even though the TS editor warns.

## Commands

```sh
pnpm install                        # install all workspace deps
pnpm --filter clay-cms build        # build core (must build first — others depend on it)
pnpm --filter @clay-cms/drizzle build
pnpm --filter @clay-cms/db-d1 build
pnpm --filter playground dev        # start Astro dev server
pnpm dev                            # all packages in watch mode + playground
pnpm test                           # run all tests (vitest)
pnpm lint:fix                       # biome auto-fix
```

Build order matters: `clay-cms` → `@clay-cms/drizzle` → `@clay-cms/db-d1` → playground.

## Design Philosophy

- **Payload CMS influence**: dedicated `clay.config.ts` file as single source of truth, collection-based config, upload as collection flag, auth as collection flag, field types as discriminated unions, `relationTo` for upload refs.
- **Adapter-based, runtime-agnostic core**: the CMS itself is not tied to any host. Databases plug in as `DatabaseAdapterResult` factories (D1 is just the first), storage plugs in as `StorageAdapterResult` (R2 is just the first). Runtime code uses Web-standard APIs only — no Node.js built-ins — so it can execute anywhere Astro SSR runs, including edge runtimes like workerd. Node APIs are fine in integration handlers, which run at config time.
- **Minimal surface**: don't add abstractions until needed. Three similar lines > premature helper.
- **Astro integration**: the CMS is an Astro integration (`astro-integration-kit`, using `defineIntegration` + `withPlugins`). Config validation happens at integration setup time, not runtime.

## Field Types

`text`, `number`, `boolean`, `select` (options array), `upload` (relationTo → upload collection slug). System fields (id, createdAt, updatedAt), upload fields (filename, mimeType, filesize, url, width, height), and auth fields (email, hashedPassword) are auto-merged by `resolveCollections()`.

## Authentication

- **Collection-level auth**: any collection can have `auth: true` (like Payload CMS). v1 requires exactly one auth collection.
- **`admin.user` (required)**: top-level config explicitly designates which auth collection backs the dashboard, e.g. `admin: { user: users.slug }` (Payload-style). Validated at boot: must reference an existing collection with `auth: true`. This replaces an earlier implicit `collections.find(c => c.auth)` scan and becomes the sole entry point for auth flows in middleware/actions, which import it via `config.admin.user` from `virtual:clay-cms/config`.
- **No external auth library** — `bcryptjs` for password hashing, random session tokens in `_sessions` DB table.
- **No API routes** — all auth flows (setup, login, logout) go through Astro Actions with built-in CSRF protection.
- **Actions**: defined in `packages/clay-cms/src/actions.ts` (shipped as source, not compiled by tsup). Users re-export: `export { server } from "clay-cms/actions"` in their `src/actions/index.ts`.
- **Auth fields auto-merged**: `email` (unique, required) + `hashedPassword` (required). Users define additional fields (name, role, etc.) in their collection config.
- **Session management**: `_sessions` table with random 32-byte tokens (via `crypto.getRandomValues()`). 30-day expiry. Cookie: `clay-cms.session`.
- **Auth utilities**: `packages/clay-cms/src/auth/` — `password.ts` (hash/verify), `session.ts` (create/validate/delete + cookie helpers), `types.ts`. Shipped as source, exported via `clay-cms/auth`.
- **First-user flow**: admin middleware detects zero users → redirects to `/admin/setup`. Setup action guards against race conditions (check before insert) and **force-assigns `role: "admin"`** to the first user, ignoring any client-supplied role. This guarantees the bootstrap account can manage others.
- **Two middlewares**:
  - **Global session middleware** (`src/runtime/session-middleware.ts`, `pre`, every request): `ensureTables()`, reads/validates cookie, populates `locals.clayUser` + `locals.claySession`. Never redirects — lets Clay back public-facing auth, not just admin.
  - **Admin guard** (`src/admin/middleware.ts`, `post`, `/admin/*` only): reads `locals.clayUser`, handles setup/login redirects, runs `access.admin`. No cookie reading here.
- **Auto-table-creation**: on first request the session middleware runs `CREATE TABLE IF NOT EXISTS` for all collection tables + `_sessions`. SQL is generated at config time by the adapter's `generateInitSQL()` and baked into `virtual:clay-cms/config` as a JSON array.

## Access Control

Per-collection ACL inspired by Payload + Kide. Lives in `packages/clay-cms/src/access/`, exported via `clay-cms/access`.

### Shape

```ts
import { fields, defineCollection } from "clay-cms/config";
import { isLoggedIn, isAdmin, isSelf, or } from "clay-cms/access";

export const users: CollectionConfig = {
  slug: "users",
  auth: true,
  fields: {
    name: fields.text({ required: true }),
    role: fields.select({ options: ["admin", "editor", "customer"], required: true }),
  },
  access: {
    // ? per-op; missing ops fall back to tiered defaults — you can specify just one
    update: or(isAdmin, isSelf),
  },
};
```

### Operations & context

Five ops: `read`, `create`, `update`, `delete`, `admin`. Each access fn receives `{ user, operation, collection, id?, doc? }` and returns `boolean | Where | Promise<...>` (Payload parity). `user` is `null` for anonymous requests, never `undefined` inside an enforced call.

**Where-returning access** lets a rule say "allowed, but only for matching docs" without per-call-site filtering. `find` AND-merges the ACL `Where` with `opts.where`. `findOne`/`update`/`delete` load the doc (already needed for the gate) and run `matchesWhere(aclWhere, doc)`. `create` runs `matchesWhere` against incoming data.

The same `Where` type powers ACL v2, `find({ where })`, and the (future) admin filter UI. Two evaluators share it: `matchesWhere()` in `clay-cms/access` (in-memory) and `whereToDrizzle()` in `@clay-cms/drizzle` (SQL). Operators: `equals`, `not_equals`, `in`, `not_in`, `exists`, `greater_than(_equal)`, `less_than(_equal)`, `like` (case-insensitive substring, Payload semantics), `contains`, plus `and`/`or`. Dot-paths and localized-field filtering deferred.

The `admin` op is **only meaningful on auth collections** — it gates dashboard entry. Replaces what would otherwise be a string-based `requireRole` config; same primitive as the other ops.

### Helpers

`clay-cms/access` exports: `isLoggedIn`, `isAdmin` (`user?.role === "admin"`), `isSelf`, `and`, `or`, `not`, `ownDocuments(field)` (returns a `Where` filtering on the user id — the storefront-pattern killer), and `andWhere`/`orWhere` for raw `Where` merging. Plus the `AccessDeniedError` class and the types `AccessFn`/`AccessResult`/`AccessContext`/`CollectionAccess`/`Where`/`WhereOperator`.

The `and`/`or` combinators handle the cross product of `boolean` and `Where` results: in `or`, `true` short-circuits (most permissive wins); in `and`, `false` short-circuits; mixed Wheres accumulate into `{ and: [...] }` / `{ or: [...] }`. `not()` is boolean-coerced — negating a `Where` is ill-defined and not supported.

The north-star pattern is one line: `read: or(isAdmin, ownDocuments("customer"))`.

### Tiered defaults (filled by `resolveCollections`)

- **Content collections** (`auth` falsy): `read = () => true`, `create/update/delete = isLoggedIn`. No `admin` op.
- **Auth collections** (`auth: true`): `read = isLoggedIn`, `create = isAdmin`, `update = or(isAdmin, isSelf)`, `delete = and(isAdmin, !isSelf)`, `admin = isAdmin`.

User-supplied access merges per-op against these defaults — defining only `update` does NOT wipe the others.

### Single CMS surface, secure by default

There is one `cms` import — `import cms from "virtual:clay-cms/api"` — and every call enforces the gate. The caller threads `user` explicitly:

```ts
// public storefront / admin page / action — same shape
await cms.orders.find({ user: Astro.locals.clayUser });

// trusted system code — explicit bypass (rare: bootstrap, login, seed scripts)
await cms.users.create({ data, overrideAccess: true });
```

The single gate rule inside the proxy:

```
if (opts.overrideAccess === true) → bypass
otherwise                         → enforce, ctx.user = opts.user ?? null
```

**Forgetting `user` is denied, not leaked.** A missing `user` key is enforced as anonymous (`null`), so a typo or oversight can never silently bypass ACL. The only way to skip the gate is `overrideAccess: true`, which is grep-able.

`overrideAccess: true` means **act as root**. Use it sparingly and intentionally — every call site is an audit point. Today's only legitimate uses inside Clay itself are: `actions.ts` setup (creates the first admin pre-auth), `actions.ts` login (looks up the user by email pre-auth), and `admin/middleware.ts` (the bootstrap users-exist check). User-land equivalents: seed scripts, migrations, hooks that need to read across users.

### Immutable invariant: auth-collection deletes

The proxy's `delete` op enforces two rules on auth collections that **cannot be disabled** (not even by user-supplied `access.delete`):

1. You cannot delete your own account (self-delete).
2. You cannot delete the last user in the collection.

This is the original bug the whole ACL system was built to make impossible. Lives in `runtime/api.ts`, not in `access/defaults.ts`, because it's a runtime invariant, not a default.

### Errors

Denied calls throw `AccessDeniedError` (carries `collection`, `operation`). Admin pages catch → 403. Actions catch → `ActionError({ code: "FORBIDDEN" })`.

### `can()` — pre-flight permission check

`cms.<slug>.can(op, opts)` runs the gate, catches `AccessDeniedError`, and returns boolean. Pass `user: Astro.locals.clayUser` like any other call. Used by the admin UI to hide buttons the user can't act on (e.g. don't render Save when `update` is denied for this doc). For ops that need a doc (read/update/delete), pass `{ id }` and it loads the doc, or pass `{ doc }` directly. Per-op rather than bulk — if the admin UI ever needs a bulk permissions object, add an `access()` method then.

### Field-level access

Per-field `access.read`/`create`/`update` on any `FieldConfig`. Boolean-only (Payload parity — `Where` stays collection-level). Lives on `BaseField`. `isLoggedIn`/`isAdmin` are dual-typed (`AccessFn & FieldAccessFn`) so they work in both slots; `isSelf`/`ownDocuments` stay collection-only.

Three runtime helpers in `clay-cms/access`, all working off the resolved field map:
- `applyReadFieldAccess(collection, doc, user)` — strips `read`-denied fields. Called per-doc in `find()` (after `afterRead` hooks) and `findOne()`. Returns a new object.
- `applyWriteFieldAccess(collection, data, op, user, existing?)` — drops denied fields silently, `console.warn`s in dev. Runs **before** `beforeChange` so hooks can't smuggle values past the gate.
- `evaluateFieldAccess(collection, doc, user)` — returns `Map<fieldName, { canRead, canUpdate }>`. Used by the admin edit page: read-denied don't render, update-denied render `disabled`.

**Hot-path skip.** `resolveCollections()` sets `hasFieldLevelAccess?: { read?, create?, update? }` at boot; the gate consults it before calling helpers. Zero cost when unused.

**Silent drop, not throw** (Payload parity): forms can submit without mirroring user perms. Dev `console.warn` catches typos. **`overrideAccess: true` skips field gate too.**

**Hook ordering vs field-level ACL:**
- Read: CRUD → `beforeRead` → `afterRead` → field strip → consumer.
- Write: field drop → `beforeChange` → CRUD → `afterChange`.

Field-level *hooks* deferred — same field-walk machinery will be reused.

## Virtual modules (config-time → runtime bridge)

Astro integration hooks run at build/config time in Node. SSR code may run in a different runtime (e.g. workerd under `@astrojs/cloudflare` v13, where `globalThis` is not even shared with the Node-side hooks). Virtual modules are how config-time data and adapter-provided code cross that boundary in a host-agnostic way.

There are **four** virtual modules:

- **`virtual:clay-cms/drizzle`** — adapter-provided code that lazily initializes a Drizzle instance from whatever the host exposes (e.g. Cloudflare bindings for the D1 adapter). `drizzleModuleCode` is a raw JS string the adapter exposes.
- **`virtual:clay-cms/api`** — one-line re-export of `src/runtime/api.ts` (the cms proxy). Real, type-checked TS file shipped as source.
- **`virtual:clay-cms/init-sql`** — one-line re-export of `src/runtime/init-sql.ts` (`ensureTables()`). Real TS file shipped as source.
- **`virtual:clay-cms/config`** — **generated bridge module**. Imports the user's `clay.config.ts` as a real ESM module (Vite bundles it into the workerd build, so collection hook closures, validators, and any user functions ride along untouched), calls `resolveCollections()` at runtime, and exposes `{ collections, localization, admin, initSqlStatements }`. `admin` is the user's `AdminConfig` (`{ user: <slug> }`) — the explicit pointer to the auth-enabled collection that backs the dashboard. `initSqlStatements` is the only thing baked in as JSON because it's pure data computed at config time by the db adapter.

No separate hooks codegen module — the user's `clay.config.ts` is imported directly, so hook closures ride along untouched.

## Local API

- **Kide-style**: `cms.posts.find()`, `cms.admins.create({ data: {...} })` — collection as dot-notation property.
- **Virtual module**: `virtual:clay-cms/api` — available in all SSR code (middleware, actions, Astro pages, user app).
- **Proxy-based**: runtime uses a `Proxy` that maps `cms[slug]` to `{ find, findOne, create, update, delete }` methods backed by the CRUD layer.
- **Hooks**: read at request time from a slug→config map built once at module init from the imported collections array. Closures preserved because collections come from a real ESM import of `clay.config.ts` (no JSON serialization).
- **Internal helpers**: `cms.__tables()` (raw drizzle tables), `cms.__db()` (raw drizzle db) — used by auth middleware/actions, not part of public API. The admin user collection slug comes from `config.admin.user` (imported from `virtual:clay-cms/config`), not from the cms proxy.
- **Types**: per-collection interfaces generated at config time, injected via `injectTypes`. No CLI step. Each slug gets a PascalCase `Doc` (`posts` → `Post`) plus `PostCreateInput` (`Omit<Post,"id"|"createdAt"|"updatedAt">`) and `PostUpdateInput` (`Partial<CreateInput>`). `CMS` interface maps slugs → `CollectionAPI<Doc, CreateInput, UpdateInput>`. Field→TS: `text`→`string`, `number`→`number`, `boolean`→`boolean`, `select`→string-literal union (`Array<...>` if `multiple`), `upload`→`string` (id). Required fields are non-optional.
- **Auto-regeneration**: `loadClayConfig` enumerates `jiti.cache` and returns every loaded project file; integration calls `addWatchFile` on each, so editing any imported file restarts Astro → types regenerate. jiti uses `moduleCache: false`.
- **Dialect-agnostic**: `runtime/api.ts` imports zero dialect-specific drizzle packages. It reads `drizzle.schemaConfig` from the adapter's virtual module and passes it through to `buildSchema()`. Any future db adapter (db-postgres, db-libsql) ships its own `drizzleModuleCode` exporting a flavored `schemaConfig` and works without touching this file.

## Hooks

Per-collection lifecycle hooks, Payload-shaped but runtime-agnostic. Lives on the `hooks` field of `CollectionConfig`. All hooks are arrays, all are optional, all are async-aware.

### Surface

Six hooks, day one. Field-level hooks, `beforeOperation`/`afterOperation`, `beforeValidate`, and auth hooks (`beforeLogin`, etc.) are deferred — same "collection-first, field-second" deferral as field-level ACL.

| Hook | Fires | Args | Return |
|---|---|---|---|
| `beforeChange` | before create + update | `{ data, originalDoc?, operation, collection, user, context, id? }` | new `data` (or `void` to keep) |
| `afterChange` | after create + update | `{ doc, previousDoc?, operation, collection, user, context, id? }` | `void` |
| `beforeRead` | per-doc, before projection | `{ doc, collection, user, context }` | new `doc` (or `void`) |
| `afterRead` | per-doc, after projection | `{ doc, collection, user, context }` | new `doc` (or `void`) |
| `beforeDelete` | before delete | `{ id, doc, collection, user, context }` | `void` |
| `afterDelete` | after delete | `{ id, doc, collection, user, context }` | `void` |

`originalDoc` / `previousDoc` are present only on update — and free, because the ACL gate already loads the existing doc. `id` mirrors that.

### Differences from Payload

- **No `req` object** — runtime-agnostic core. `user` is top-level; Astro state goes through `context`.
- **No `req.payload`** — hooks just `import cms from "virtual:clay-cms/api"`.
- **`user` is `null`, never `undefined`** (anonymous + raw-import bypass both → null).
- **Bypass still runs hooks.** `overrideAccess: true` skips the access gate, NOT business logic. Hooks fire in the proxy (not CRUD) so every entry point runs them. Hook order/mutation/throw-to-abort/per-doc read hooks are all Payload-shaped — mental model transfers 1:1.

### `context` — per-operation scratchpad

Every hook receives a `context: Record<string, unknown>`. The same object is threaded through every hook in one top-level operation (e.g. `beforeChange` → CRUD write → `afterChange` see the *same* reference). Mint fresh `{}` per op when the caller doesn't supply one; or pass your own:

```ts
await cms.posts.update({ id, data, context: { skipNotify: true, requestId: "abc" } });
```

Use it for recursion guards (`if (context.skipNotify) return`), diffing between before/after, or stashing host state without polluting hook signatures.

### Hot-path skip

`find()` skips the per-doc read-hook loop entirely on collections that define neither `beforeRead` nor `afterRead`, returning rows directly from CRUD with no allocation. Pay only when you opt in.

### Gotchas

- **`after*` rollback depends on the adapter.** Throwing `afterChange`/`afterDelete` rolls back **only inside `cms.transaction(fn)` on adapters whose drizzle driver supports interactive transactions** (libsql/postgres/better-sqlite3). D1 has no `db.transaction`, so use `before*` for anything that must abort. The localized orphan-row hole is closed independently via `db.batch()` in CRUD (see Transactions).
- **Hook order = array order**, sequential, awaited. Each receives previous return.
- **Read hooks run per-doc inside `find()`** — N calls per find.
- **Bypass `update`/`delete` lazily loads `existing`** when hooks are defined, so `originalDoc`/`doc` are always present.

## Transactions

Atomicity story is split across two layers — `db.batch()` inside CRUD (always on, fixes the corruption bug) and `cms.transaction(fn)` on top of `db.transaction` (opt-in, full Payload-style rollback semantics where the driver supports it).

### `db.batch()` inside CRUD — always on

Localized `create`/`update`/`delete` write to two tables (the main row and `_translations`). Pre-P0-#4, those were two separate awaits, so a failure on the second left an orphan main row — silent corruption. As of the transaction slice, `@clay-cms/drizzle/crud.ts` builds both statements, then routes them through `db.batch([s1, s2])` when the drizzle driver exposes one. drizzle-orm's D1 driver does, so the playground (the only place this matters today) gets atomic localized writes for free, no API change. Drivers without `.batch()` (better-sqlite3 in tests) fall back to sequential awaits — same behavior as before. Ships the orphan-row fix on D1 today, regardless of whether anyone calls `cms.transaction(fn)`.

### `cms.transaction(fn)` — Payload-style atomic block

```ts
import cms from "clay-cms/api";

await cms.transaction(async (tx) => {
  const order = await tx.orders.create({ data, user: Astro.locals.clayUser });
  await tx.inventory.update({ id: order.itemId, data: { stock: 0 }, overrideAccess: true });
  // ? a throw here — including from an afterChange hook on either op — rolls back BOTH writes
});
```

- `tx` is a cms-shaped proxy sharing a tx-bound drizzle instance. **Not a stealth bypass** — calls still enforce the gate, you still thread `user`/`overrideAccess`. Refuses nesting (savepoints deferred).
- **Feature-detected** via `typeof db.transaction === "function"` — no `DatabaseAdapter` method, no provider switch. D1 throws a clear error rather than lie about rollback. Payload's `beginTransaction → null` opt-out, JS-flavored.
- **Rollback covers `after*` hooks** because hooks fire in the proxy — closes the gotcha on tx-supporting adapters.
- **No `req.transactionID`** — per-op `context` + drizzle tx closure handle it; hook signatures stay clean.

## Admin UI

- Routes are injected via `injectRoute` in `astro:config:setup` — one `.astro` file per route (not a catch-all).
- Admin files live in `packages/clay-cms/src/admin/` — structured like a mini Astro app:
  ```
  src/admin/
    index.astro              ← dashboard (protected by middleware)
    setup.astro              ← first-user creation form
    login.astro              ← email/password login form
    middleware.ts            ← auth guard (injected via addMiddleware)
    components/
      BaseHead.astro         ← charset, viewport, noindex/nofollow, title
    layouts/
      BaseLayout.astro       ← uses BaseHead, imports Tailwind CSS
    styles/
      styles.css             ← @import "tailwindcss" + @source for admin .astro files
  ```
- `.astro` files are shipped as source (not compiled by tsup). They're included via `"files": ["src/admin"]` and route entrypoints are exported in `package.json`.
- Tailwind v4 is registered via `@tailwindcss/vite` in the integration (uses `hasVitePlugin` from `astro-integration-kit` to avoid duplicate registration).
- `@source "../**/*.astro"` in `styles.css` tells Tailwind to scan admin files inside `node_modules`.
- Admin pages use the local API (`cms[slug].find()`) to fetch documents for all collections including auth.
- `hashedPassword` is excluded from display columns in the admin UI.
- **ACL-driven UI**: the document edit page calls `cms[slug].can("update"|"delete", { doc, user: Astro.locals.clayUser })` and hides Save / Delete (and disables form inputs via `FieldInput`'s `disabled` prop) when the current user can't perform the op. The Cancel link becomes "Back" in read-only mode. This is the surface-side of the access-control work — buttons react to ACL rules without per-page conditional logic beyond a single `can()` call.

## Localization (Field-Level i18n)

- **Config**: optional `localization: { locales: ["en", "fr"], defaultLocale: "en" }` in `clay.config.ts`
- **Field-level opt-in**: `localized: true` on `TextField` and `SelectField` only (TS enforces this — other field types don't have the property)
- **Storage**: default locale data lives on the **main table** (zero-JOIN reads). Non-default translations go in `{slug}_translations` sibling table.
- **Schema**: `buildSchema()` generates `{slug}_translations` with `id`, `_parentId`, `_locale`, + localized field columns, plus `UNIQUE(_parentId, _locale)` constraint.
- **CRUD semantics**:
  - No `locale` / default locale → main table only (unchanged behavior)
  - Non-default locale reads → `LEFT JOIN _translations`, overlay localized fields onto base doc
  - Non-default locale writes → upsert into `_translations` via `onConflictDoUpdate`
  - Delete → explicitly removes translation rows first (D1 doesn't enforce FK CASCADE)
- **Resolve**: `resolveCollections()` sets `hasLocalizedFields: true` on collections with localized fields when localization config is present
- **Validation**: `localized: true` without global config → error; `defaultLocale` not in `locales` → error
- **Constraint**: default locale is immutable after content creation (v1)

## Testing

- **Vitest** at the workspace root. Config in `vitest.config.ts` scans `packages/*/src/**/*.spec.ts`.
- Test files are co-located with source (`schema.spec.ts` next to `schema.ts`). tsup excludes `*.spec.ts` from builds.
- **`@clay-cms/drizzle`**: uses `better-sqlite3` for in-memory SQLite integration tests. The `createTablesInDb` test helper introspects drizzle schema via `getTableConfig()` to generate DDL — test DB always matches what `buildSchema()` produces. Production DDL is generated by `generateCreateStatements()` in `ddl.ts` (same logic, exported for adapters to use).
- **Test philosophy**: test the logic layer (`@clay-cms/drizzle`), not thin adapters (`db-d1`). Adapters just wire up bindings and delegate. When adding new adapters that also use `@clay-cms/drizzle`, existing tests already cover the shared logic.
- **`any` in drizzle types**: acceptable at the dialect-abstraction boundary (`SchemaBuilderConfig`, `TableMap`). Drizzle's internal generics are too complex to type precisely without coupling to a specific dialect. Avoid `any` in business logic and public APIs.
- **Testing source-shipped runtime files** (`runtime/api.ts`, `session-middleware.ts`): `vitest.config.ts` aliases map `clay-cms/access`, `clay-cms/auth`, `astro:middleware` to local sources. `packages/clay-cms/src/test-shims/` holds Astro-virtual stand-ins (currently `astro-middleware.ts` with `defineMiddleware = identity`). Specs use `vi.mock("virtual:clay-cms/...")` per file. `api.spec.ts` runs the cms proxy gate against an in-memory CRUD fake reusing real `matchesWhere`.
- **No `any` or `!` in spec files** — banned. Use typed helpers (`asRow`/`asRows`, `rowsOf`), guarded destructures, or `as unknown as T` at boundaries. Reference style: `auth/session.spec.ts`.
- **Regression-pin tests** point at ROADMAP entries with a comment; failing forces the fix. Today: `where.spec.ts > "like: handles SQL wildcards as literals"` and `crud.spec.ts > "find with where on a localized field in non-default locale"`.
- CI runs `pnpm test` after build.

## Roadmap

A `ROADMAP.md` file at the repo root tracks planned work (P0/P1/P2, non-goals, open design questions). It's **gitignored** — treat it as a local scratchpad, not a public commitment. When the user asks about future work, priorities, or "what's next," read it first. When architectural decisions land, update both `CLAUDE.md` (for the new state of the world) and `ROADMAP.md` (to check items off or add new ones).

## Current Limitations

- No production migration tooling yet — auto-table-creation (CREATE TABLE IF NOT EXISTS) works for dev but ALTER TABLE / data migrations need a CLI command (like Payload's `payload migrate`).
- Only one db adapter (`@clay-cms/db-d1`) ships today. The runtime is dialect-agnostic — adding `db-postgres` / `db-libsql` is "implement an adapter that exposes `DrizzleAccessor.schemaConfig`," not a fork of `runtime/api.ts`.
- `actions` re-export still requires the user to add `export { server } from "clay-cms/actions"` to their `src/actions/index.ts` manually. Could be auto-injected.
- **Field-level _hooks_** are deferred. Field-level _access_ is shipped (`access.read`/`create`/`update` per field, boolean-only). Hooks follow the same collection-first/field-second deferral pattern and will reuse the same field-walk machinery when they land.
- **Where-clause dot-paths and localized-field filtering** are deferred. Day-one Where supports flat fields only; relationship traversal (`"customer.email"`) waits on the `relationship` field type, and non-default-locale `_translations` joins in `whereToDrizzle` are a known follow-up.
