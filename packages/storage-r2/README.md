# @clay-cms/storage-r2

> Cloudflare R2 storage adapter for [Clay CMS](https://www.npmjs.com/package/clay-cms).

Backs Clay's upload collections with a [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket. Handles upload, delete, and serving of files through your Worker's R2 binding.

## Installation

```bash
pnpm add @clay-cms/storage-r2
```

## Usage

Point the adapter at an R2 binding defined in your `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "r2_buckets": [
    { "binding": "CLAY_BUCKET", "bucket_name": "clay-media" }
  ]
}
```

```ts
// clay.config.ts
import { defineConfig } from "clay-cms/config";
import { d1 } from "@clay-cms/db-d1";
import { r2 } from "@clay-cms/storage-r2";

export default defineConfig({
  db: d1({ binding: "CLAY_DB" }),
  storage: r2({ binding: "CLAY_BUCKET" }),
  // …collections, admin
});
```

That's the whole surface: `r2({ binding })` where `binding` is the name of the R2 binding on your Worker's `env`. Any collection with `upload: true` will store its files here.

## Part of Clay CMS

Clay is an Astro-native, adapter-based headless CMS. This package is one storage adapter — see the main [**clay-cms**](https://www.npmjs.com/package/clay-cms) package for the full picture.

- 📦 [clay-cms on npm](https://www.npmjs.com/package/clay-cms)
- 🌐 [Documentation](https://clay-cms.reeple.studio)
- 🐙 [GitHub](https://github.com/reeple-studio/clay-cms)

[MIT Licensed](https://github.com/reeple-studio/clay-cms/blob/main/LICENSE) · Made with ❤️ by [REEPLE Studio](https://github.com/reeple-studio)
