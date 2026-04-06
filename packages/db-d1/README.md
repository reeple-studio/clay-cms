# @clay-cms/db-d1

> Cloudflare D1 database adapter for [Clay CMS](https://www.npmjs.com/package/clay-cms).

Backs Clay with a [Cloudflare D1](https://developers.cloudflare.com/d1/) database. SQLite dialect, resolved lazily from your Worker's binding — no connection string in the bundle. Localized writes are made atomic via D1's `batch()`; interactive transactions (`cms.transaction(fn)`) are not supported by D1 and throw a clear error (use [`@clay-cms/db-libsql`](https://www.npmjs.com/package/@clay-cms/db-libsql) if you need them).

## Installation

```bash
pnpm add @clay-cms/db-d1
```

## Usage

Point the adapter at a D1 binding defined in your `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "d1_databases": [
    { "binding": "CLAY_DB", "database_name": "clay", "database_id": "…" }
  ]
}
```

```ts
// clay.config.ts
import { defineConfig } from "clay-cms/config";
import { d1 } from "@clay-cms/db-d1";

export default defineConfig({
  db: d1({ binding: "CLAY_DB" }),
  // …storage, collections, admin
});
```

That's the whole surface: `d1({ binding })` where `binding` is the name of the D1 binding on your Worker's `env`.

## Part of Clay CMS

Clay is an Astro-native, adapter-based headless CMS. This package is one database adapter — see the main [**clay-cms**](https://www.npmjs.com/package/clay-cms) package for the full picture.

- 📦 [clay-cms on npm](https://www.npmjs.com/package/clay-cms)
- 🌐 [Documentation](https://clay-cms.reeple.studio)
- 🐙 [GitHub](https://github.com/reeple-studio/clay-cms)

[MIT Licensed](https://github.com/reeple-studio/clay-cms/blob/main/LICENSE) · Made with ❤️ by [REEPLE Studio](https://github.com/reeple-studio)
