# @clay-cms/drizzle

> Dialect-agnostic [Drizzle ORM](https://orm.drizzle.team/) schema builder and CRUD engine for [Clay CMS](https://www.npmjs.com/package/clay-cms).

The shared logic layer every Clay database adapter builds on. It takes a table factory plus a set of semantic column builders and produces the Drizzle schema and CRUD operations for a collection — so an adapter is little more than driver wiring plus a handful of column mappings.

> [!NOTE]
> This is an **internal building block for database adapter authors**. If you just want to use Clay, install [`clay-cms`](https://www.npmjs.com/package/clay-cms) and a database adapter like [`@clay-cms/db-d1`](https://www.npmjs.com/package/@clay-cms/db-d1) or [`@clay-cms/db-libsql`](https://www.npmjs.com/package/@clay-cms/db-libsql) — you don't depend on this package directly.

## Installation

```bash
pnpm add @clay-cms/drizzle
```

## What's inside

- **`buildSchema(collections, schemaConfig, localization?)`** — turns resolved collections into Drizzle tables, including `_translations`, `_sessions`, and `_rate_limits` system tables.
- **`createCrud(...)`** — the dialect-agnostic CRUD engine (`find` / `findOne` / `create` / `update` / `delete`) with field projection, localization overlay, atomic write guards, and `batch()`-based atomicity.
- **`generateCreateStatements(tables, getTableConfig)`** — DDL generation for auto-table-creation.
- **`whereToDrizzle(where)`** — compiles Clay's `Where` type to a Drizzle SQL predicate (the SQL half of the access-control evaluator pair).
- **`sqliteSchemaConfig` / `sqliteSchemaModuleSource`** — the shared SQLite column vocabulary, so every SQLite-family adapter (D1, libSQL, …) stays in lockstep instead of re-declaring the mapping.

The core is dialect-agnostic: pass a `SchemaBuilderConfig` (table factory + six semantic column builders) and it works with any Drizzle dialect. Adding a Postgres or MySQL adapter is a new `schemaConfig`, not a fork of this package.

## Part of Clay CMS

See the main [**clay-cms**](https://www.npmjs.com/package/clay-cms) package for the full picture.

- 📦 [clay-cms on npm](https://www.npmjs.com/package/clay-cms)
- 🌐 [Documentation](https://clay-cms.reeple.studio)
- 🐙 [GitHub](https://github.com/reeple-studio/clay-cms)

[MIT Licensed](https://github.com/reeple-studio/clay-cms/blob/main/LICENSE) · Made with ❤️ by [REEPLE Studio](https://github.com/reeple-studio)
