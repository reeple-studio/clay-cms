// ? Tests for validateCollections — boot-time guards that gate the entire system.
// ? If any of these wave through bad config, the dev server lights up at runtime
// ? with confusing errors. The test surface is the *error messages*, since they
// ? are what users see when their `clay.config.ts` is wrong.

import { describe, expect, it } from "vitest";
import type { CollectionAccess } from "../access/types.js";
import type { CollectionConfig } from "./types.js";
import { validateCollections } from "./validate.js";

const users: CollectionConfig = {
	slug: "users",
	auth: true,
	fields: { name: { type: "text", required: true } },
};

const posts: CollectionConfig = {
	slug: "posts",
	fields: { title: { type: "text", required: true } },
};

const adminCfg = { user: "users" };

describe("validateCollections — basic guards", () => {
	it("throws when collections array is empty", () => {
		expect(() => validateCollections([])).toThrow(
			/At least one collection must be defined/,
		);
	});

	it("throws on duplicate slugs", () => {
		expect(() =>
			validateCollections(
				[users, { ...posts, slug: "users" }],
				undefined,
				adminCfg,
			),
		).toThrow(/Duplicate collection slug: "users"/);
	});

	it("throws when no auth collection is defined", () => {
		expect(() => validateCollections([posts], undefined, adminCfg)).toThrow(
			/Exactly one collection must have `auth: true`/,
		);
	});

	it("throws when more than one auth collection is defined", () => {
		expect(() =>
			validateCollections(
				[users, { ...users, slug: "admins" }],
				undefined,
				adminCfg,
			),
		).toThrow(/Only one collection can have `auth: true`/);
	});
});

describe("validateCollections — admin.user", () => {
	it("throws when admin is missing", () => {
		expect(() => validateCollections([users])).toThrow(
			/`admin\.user` must be set/,
		);
	});

	it("throws when admin.user references a non-existent collection", () => {
		expect(() =>
			validateCollections([users], undefined, { user: "ghosts" }),
		).toThrow(
			/`admin\.user` references collection "ghosts" which does not exist/,
		);
	});

	it("throws when admin.user references a non-auth collection", () => {
		expect(() =>
			validateCollections([users, posts], undefined, { user: "posts" }),
		).toThrow(/does not have `auth: true`/);
	});

	it("passes when admin.user correctly references the auth collection", () => {
		expect(() =>
			validateCollections([users, posts], undefined, adminCfg),
		).not.toThrow();
	});
});

describe("validateCollections — auth + upload mutual exclusion", () => {
	it("throws when a collection has both auth and upload", () => {
		const bad: CollectionConfig = {
			slug: "weird",
			auth: true,
			upload: true,
			fields: { name: { type: "text" } },
		};

		expect(() =>
			validateCollections([bad], undefined, { user: "weird" }),
		).toThrow(/cannot have both `auth: true` and `upload: true`/);
	});
});

describe("validateCollections — upload field references", () => {
	it("throws when an upload field points to a non-existent collection", () => {
		const withBadRef: CollectionConfig = {
			slug: "posts",
			fields: {
				cover: { type: "upload", relationTo: "nonexistent" },
			},
		};

		expect(() =>
			validateCollections([users, withBadRef], undefined, adminCfg),
		).toThrow(
			/references upload collection "nonexistent" which either does not exist/,
		);
	});

	it("throws when an upload field points to a non-upload collection", () => {
		const withBadRef: CollectionConfig = {
			slug: "posts",
			fields: { cover: { type: "upload", relationTo: "users" } },
		};

		expect(() =>
			validateCollections([users, withBadRef], undefined, adminCfg),
		).toThrow(/references upload collection "users" which either/);
	});

	it("passes when an upload field points to a real upload collection", () => {
		const media: CollectionConfig = {
			slug: "media",
			upload: true,
			fields: {},
		};

		const withRef: CollectionConfig = {
			slug: "posts",
			fields: { cover: { type: "upload", relationTo: "media" } },
		};

		expect(() =>
			validateCollections([users, media, withRef], undefined, adminCfg),
		).not.toThrow();
	});
});

describe("validateCollections — localization", () => {
	it("throws when a field is localized but no global localization config is set", () => {
		const localized: CollectionConfig = {
			slug: "posts",
			fields: { title: { type: "text", localized: true } },
		};

		expect(() =>
			validateCollections([users, localized], undefined, adminCfg),
		).toThrow(
			/Field "title" in collection "posts" has `localized: true` but no `localization` config/,
		);
	});

	it("throws when defaultLocale is not in locales", () => {
		expect(() =>
			validateCollections(
				[users],
				{ locales: ["en", "fr"], defaultLocale: "de" },
				adminCfg,
			),
		).toThrow(/`defaultLocale` "de" is not included in `locales`/);
	});

	it("passes when localized field has matching localization config", () => {
		const localized: CollectionConfig = {
			slug: "posts",
			fields: { title: { type: "text", localized: true } },
		};

		expect(() =>
			validateCollections(
				[users, localized],
				{ locales: ["en", "fr"], defaultLocale: "en" },
				adminCfg,
			),
		).not.toThrow();
	});
});

describe("validateCollections — access blocks", () => {
	it("throws on unknown access op", () => {
		const bad: CollectionConfig = {
			slug: "posts",
			fields: { title: { type: "text" } },
			access: { bogus: () => true } as unknown as CollectionAccess,
		};

		expect(() =>
			validateCollections([users, bad], undefined, adminCfg),
		).toThrow(/unknown access op "bogus"/);
	});

	it("throws when an access op is not a function", () => {
		const bad: CollectionConfig = {
			slug: "posts",
			fields: { title: { type: "text" } },
			access: { read: true } as unknown as CollectionAccess,
		};

		expect(() =>
			validateCollections([users, bad], undefined, adminCfg),
		).toThrow(/access\.read must be a function/);
	});

	it("throws when access.admin is set on a non-auth collection", () => {
		const bad: CollectionConfig = {
			slug: "posts",
			fields: { title: { type: "text" } },
			access: { admin: () => true },
		};

		expect(() =>
			validateCollections([users, bad], undefined, adminCfg),
		).toThrow(/defines `access\.admin` but is not an auth collection/);
	});

	it("allows access.admin on auth collections", () => {
		const u: CollectionConfig = {
			...users,
			access: { admin: () => true },
		};

		expect(() => validateCollections([u], undefined, adminCfg)).not.toThrow();
	});
});
