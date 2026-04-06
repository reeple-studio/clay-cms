# Clay CMS

> [!WARNING]
> Clay is still wet. This project is in early development and nowhere near ready for production use.

**The CMS that lives inside your Astro project.** Clay is an Astro-native, adapter-based content backend with a Payload-style config file and an admin UI built with nothing but Astro — no React, no Vue, no shipped runtime framework. Pick your database, pick your storage, shape your collections, and Clay takes the shape of your project.

## Why Clay?

- **Astro-native** — ships as an Astro integration. The admin UI is plain `.astro` files. Zero UI framework dependency.
- **Your front-end, your rules** — Clay only owns your data and the `/admin` dashboard. The public-facing side is entirely yours: render with vanilla `.astro`, sprinkle in React/Svelte/Vue/Solid islands, ship a static blog or a fully interactive storefront. The local API hands you typed objects; the markup, the routing, and the design system are up to you.
- **Not a headless CMS** — Clay has no REST or GraphQL layer. Content is read and written through a typed local API from Astro server code, which means no network hop, no auth-token plumbing, no schema drift between client and server. If you need a separate front-end on another stack talking to your CMS over HTTP, reach for Payload or Sanity. Clay's bet is that for Astro projects, the local API beats the wire.
- **Adapter-based, runtime-agnostic** — any Drizzle-supported database, any blob store. The first adapters target Cloudflare D1 and R2, but the core has no hard Cloudflare dependency. Runs anywhere Astro SSR runs, edge included.
- **Config-file convention** — a single `clay.config.ts` at the project root is the source of truth. Collections, fields, access control, localization, hooks — all in one typed file.
- **Collection-based** — `auth: true` turns a collection into a user store. `upload: true` turns it into a media library. Same primitive, different shape.
- **Typed local API** — `cms.posts.find()` is fully type-safe. Types are generated from your field definitions and auto-regenerate whenever you edit your config or any file it imports.
- **Access control that reads like English** — `read: or(isAdmin, ownDocuments("customer"))`. Rules can return `boolean` or a `Where` filter, Payload-style, so "users see only their own orders" is one line.
- **Field-level i18n** — mark a field `localized: true` and Clay handles the translation table, the JOIN, and the overlay for you.
- **Secure by default** — every `cms` call enforces your access rules. Pass `user: Astro.locals.clayUser` to act as the current visitor; omit it and the call is done as anonymous. Forgetting to thread the user can never silently leak data.

## Installation

Clay requires **Astro 6+**.

```bash
pnpm astro add clay-cms
```

Or manually:

```bash
pnpm add clay-cms @clay-cms/db-d1 @clay-cms/storage-r2
```

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import clay from "clay-cms";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [clay()], // zero-arg: auto-discovers ./clay.config.ts
});
```

```ts
// clay.config.ts — single source of truth
import { defineConfig } from "clay-cms/config";
import { d1 } from "@clay-cms/db-d1";
import { r2 } from "@clay-cms/storage-r2";

import { posts } from "./src/collections/posts.ts";
import { users } from "./src/collections/users.ts";

export default defineConfig({
  db: d1({ binding: "CLAY_DB" }),
  storage: r2({ binding: "CLAY_BUCKET" }),
  collections: [posts, users],
  admin: {
    user: users.slug
  },
  localization: {
    locales: ["en", "fr"],
    defaultLocale: "en"
  },
});
```

Visit `/admin` and Clay walks you through creating the first user.

## A taste of the API

```ts
// src/clay/posts.ts — public blog: anyone can read
import { fields } from "clay-cms/config";

export const posts = {
  slug: "posts",
  fields: {
    title: fields.text({ required: true, localized: true }),
    body: fields.text({ localized: true }),
  },
  access: {
    read: () => true, // ? public
  },
};
```

```ts
// src/clay/orders.ts — customer storefront: each customer sees only their own
import { fields } from "clay-cms/config";
import { isAdmin, ownDocuments, or } from "clay-cms/access";

export const orders = {
  slug: "orders",
  fields: {
    total: fields.number({ required: true }),
    status: fields.select({
      options: ["pending", "paid", "refunded"],
      required: true,
    }),
    customer: fields.relationship({ relationTo: "users", required: true }),
  },
  access: {
    read: or(isAdmin, ownDocuments("customer")),

    // ? customers create their own order on "go to checkout". The Where rule is
    // ? matched against the incoming data, so a customer can't smuggle someone
    // ? else's id into the `customer` field — it must equal their own user id.
    create: ownDocuments("customer"),

    // ? customers must NOT be able to update their own orders — they could flip
    // ? "pending" → "paid" without actually paying. Updates are admin-only at the
    // ? ACL layer; for example the Stripe webhook does the legitimate updates via overrideAccess.
    update: isAdmin,
  },
};
```

There's a single `cms` import. Pass `user` to enforce as them; omit it and the
call is enforced as anonymous (denied unless the rule is permissive). The
session middleware populates `Astro.locals.clayUser` on every request — admin
dashboard *and* public storefront alike — so the same API works on `/blog/[id]`
and `/account/orders`.

```astro
---
// src/pages/account/orders.astro
import cms from "clay-cms/api";

// ? thread the session user — Alice gets Alice's orders, Bob gets Bob's,
// ? anonymous visitors get an empty list (the ACL filter matches nothing).
const orders = await cms.orders.find({
  user: Astro.locals.clayUser,
});
---

<h1>Your orders</h1>

<ul>
  {orders.map((order) => (
    <li>
      Order #{order.id} — ${order.total}
    </li>
  ))}
</ul>
```

For trusted system code — webhooks, seed scripts, migrations, anywhere you
need to act as root inside an otherwise-enforced codebase — use
`overrideAccess: true`:

```ts
// src/pages/api/webhooks/stripe.ts — payment confirmation from Stripe
import type { APIRoute } from "astro";
import cms from "clay-cms/api";

export const POST: APIRoute = async ({ request }) => {
  // ? verify the Stripe signature, parse the event, etc. (omitted)
  const event = await verifyStripeWebhook(request);

  if (event.type === "checkout.session.completed") {
    // ? the order's `update` ACL is admin-only — neither the customer nor an
    // ? anonymous request can flip status to "paid". This webhook is the one
    // ? legitimate caller, so it bypasses the gate explicitly and grep-ably.
    await cms.orders.update({
      id: event.data.object.metadata.orderId,
      data: { status: "paid" },
      overrideAccess: true,
    });
  }

  return new Response(null, { status: 200 });
};
```

`overrideAccess: true` is the only way to skip the gate. Forgetting to pass
`user` is denied, not silently bypassed — so a typo can never leak data.

## What ships today

- Cloudflare D1 + R2 adapters
- Collections, fields (`text`, `number`, `boolean`, `select`, `upload`), auto-merged system/upload/auth fields
- Collection- and field-level access control with `Where`-returning rules, `can()` pre-flight checks, and ACL-driven admin UI (field-level rules silent-drop denied writes and strip read-denied fields from responses)
- Collection-level auth (bcryptjs + session tokens, no external library), first-user bootstrap, login/logout via Astro Actions
- Field-level localization with a sibling `_translations` table
- Typed local API with auto-regenerating types
- Admin UI: listing + document edit page (for shipped field types)

## What's next

Clay is actively being shaped. Upcoming work includes more DB adapters (libSQL/Turso, Postgres, better-sqlite3), richer field types (Tiptap-powered `richText`, `array`/`blocks`, `relationship`), versions & drafts, migration tooling, a full-featured admin, and the headline editor-experience bet: **visual editing with click-to-edit overlays** in the Storyblok/Sanity Presentation style — edit your live storefront in place, not in a side panel. Built-in (not plugins): SEO, redirects, sitemap, import/export.

## Contributing

Clay is a pnpm workspace monorepo:

```
packages/
  clay-cms              ← core integration
  @clay-cms/drizzle     ← dialect-agnostic schema + CRUD
  @clay-cms/db-d1       ← Cloudflare D1 adapter
  @clay-cms/storage-r2  ← Cloudflare R2 adapter
playground/             ← Astro 6 + Cloudflare demo
```

```bash
pnpm i --frozen-lockfile
pnpm dev    # all packages in watch mode + playground
pnpm test   # vitest across the workspace
```

## Licensing

[MIT Licensed](https://github.com/reeple-studio/clay-cms/blob/main/LICENSE). Made with ❤️ (and a little water) by [REEPLE Studio](https://github.com/reeple-studio).

## Acknowledgements

- [Payload CMS](https://payloadcms.com) — the collection-based API, the config-file convention, and the local API pattern Clay is openly modeled on.
- [Kide](https://docs.kide.dev) — inspiration for the ergonomic, dot-notation local API shape.
- Florian Lefebvre for the [Astro Integration Kit](https://github.com/florian-lefebvre/astro-integration-kit).

Follow along on [Twitter](https://x.com/reeple_studio).