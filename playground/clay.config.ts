import { d1 } from "@clay-cms/db-d1";
import { r2 } from "@clay-cms/storage-r2";
import { defineConfig } from "clay-cms/config";

import { media } from "./src/collections/media.ts";
import { users } from "./src/collections/users.ts";

export default defineConfig({
	db: d1({ binding: "CLAY_DB" }),
	storage: r2({ binding: "CLAY_BUCKET" }),
	collections: [media, users],
	admin: { user: users.slug },
	localization: {
		locales: ["en", "fr"],
		defaultLocale: "en",
	},
});
