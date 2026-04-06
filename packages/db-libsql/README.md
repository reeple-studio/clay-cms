# @clay-cms/db-libsql

> libSQL / [Turso](https://turso.tech/) database adapter for [Clay CMS](https://www.npmjs.com/package/clay-cms).

Backs Clay with a [libSQL](https://github.com/tursodatabase/libsql) database — a remote Turso instance, a local `file:` database, or an in-memory `:memory:` one. SQLite dialect. Unlike the D1 adapter, libSQL supports **interactive transactions**, so `cms.transaction(fn)` and after-hook rollback work.

## Installation

```bash
pnpm add @clay-cms/db-libsql
```

## Usage

### Local file (dev)

```ts
// clay.config.ts
import { defineConfig } from "clay-cms/config";
import { libsql } from "@clay-cms/db-libsql";

export default defineConfig({
  db: libsql({ url: "file:local.db" }),
  // …storage, collections, admin
});
```

### Remote Turso (production)

Leave the connection out of the config so the URL and secret aren't baked into the SSR bundle — the adapter reads them from env at runtime:

```ts
export default defineConfig({
  db: libsql(), // reads TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
});
```

```bash
# .env
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=…
```

### Options

```ts
libsql({
  url,           // literal connection URL (fine for file:/:memory:)
  authToken,     // literal auth token
  urlEnv,        // env var to read the URL from (default: TURSO_DATABASE_URL)
  authTokenEnv,  // env var to read the token from (default: TURSO_AUTH_TOKEN)
});
```

Literals win when set; otherwise the env vars are read at runtime. Prefer env for remote secrets, literals for local `file:`/`:memory:` databases.

## Part of Clay CMS

Clay is an Astro-native, adapter-based headless CMS. This package is one database adapter — see the main [**clay-cms**](https://www.npmjs.com/package/clay-cms) package for the full picture.

- 📦 [clay-cms on npm](https://www.npmjs.com/package/clay-cms)
- 🌐 [Documentation](https://clay-cms.reeple.studio)
- 🐙 [GitHub](https://github.com/reeple-studio/clay-cms)

[MIT Licensed](https://github.com/reeple-studio/clay-cms/blob/main/LICENSE) · Made with ❤️ by [REEPLE Studio](https://github.com/reeple-studio)
