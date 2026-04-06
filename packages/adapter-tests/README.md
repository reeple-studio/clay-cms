# @clay-cms/adapter-tests

> Shared conformance test suite for [Clay CMS](https://www.npmjs.com/package/clay-cms) database adapters.

A reusable [Vitest](https://vitest.dev/) battery that runs the full Clay database contract — CRUD, `Where` operators, field projection, localization overlay + cascade, `_sessions` / `_rate_limits` system tables, init-SQL idempotency, `requireEmpty` / `requireOther` write guards, and driver capabilities — against a **live** adapter instance. It's how "mix and match any adapter" stays provably safe.

> [!NOTE]
> This package is **for database adapter authors**. If you're building an adapter (or a custom Clay database backend), run this suite against it. If you just want to use Clay, you don't need this.

## Installation

```bash
pnpm add -D @clay-cms/adapter-tests vitest
```

## Usage

Add a spec file to your adapter that hands the harness a factory returning a fresh adapter instance:

```ts
// src/my-adapter.spec.ts
import { runDbConformance } from "@clay-cms/adapter-tests";
import { libsql } from "@clay-cms/db-libsql";

runDbConformance({
  name: "libsql",
  makeAdapter: () => libsql({ url: ":memory:" }),
  supportsTransactions: true, // libSQL/Postgres: true. D1 (no primitive) / sync-only: false
});
```

- **`name`** — label for the test block.
- **`makeAdapter`** — returns a fresh, isolated adapter each call (e.g. a new `:memory:` database).
- **`supportsTransactions`** — whether the driver has interactive transactions. Gates the transaction-specific assertions.

A new database adapter must add a runner and pass the suite.

## Part of Clay CMS

See the main [**clay-cms**](https://www.npmjs.com/package/clay-cms) package for the full picture.

- 📦 [clay-cms on npm](https://www.npmjs.com/package/clay-cms)
- 🌐 [Documentation](https://clay-cms.reeple.studio)
- 🐙 [GitHub](https://github.com/reeple-studio/clay-cms)

[MIT Licensed](https://github.com/reeple-studio/clay-cms/blob/main/LICENSE) · Made with ❤️ by [REEPLE Studio](https://github.com/reeple-studio)
