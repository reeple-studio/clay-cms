import type { ResolvedCollectionConfig } from "clay-cms";
import {
	getTableConfig,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { buildSchema, isLocalized } from "./schema.js";
import type { SchemaBuilderConfig } from "./types.js";

const timestamp = (name: string) => text(name);
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = (name: string) => text(name, { mode: "json" });

const sqliteConfig: SchemaBuilderConfig = {
	tableFactory: sqliteTable,
	columns: { text, integer, boolean, timestamp, json },
	unique,
};

// ? permissive access stub — buildSchema doesn't read `access`, but the type
// ? requires it. Shared across fixtures in this file.
const allow = () => true;
const openAccess = {
	read: allow,
	create: allow,
	update: allow,
	delete: allow,
};

// ? ── isLocalized ─────────────────────────────────────────────────

describe("isLocalized", () => {
	it("returns true for text field with localized: true", () => {
		expect(isLocalized({ type: "text", localized: true })).toBe(true);
	});

	it("returns true for select field with localized: true", () => {
		expect(
			isLocalized({
				type: "select",
				options: ["a", "b"],
				localized: true,
			}),
		).toBe(true);
	});

	it("returns false for text field without localized", () => {
		expect(isLocalized({ type: "text" })).toBe(false);
	});

	it("returns false for non-localizable field types", () => {
		expect(isLocalized({ type: "number" })).toBe(false);
		expect(isLocalized({ type: "boolean" })).toBe(false);
		expect(isLocalized({ type: "upload", relationTo: "media" })).toBe(false);
	});
});

// ? ── buildSchema ─────────────────────────────────────────────────

describe("buildSchema", () => {
	const postsCollection: ResolvedCollectionConfig = {
		slug: "posts",
		access: openAccess,
		fields: {
			id: { type: "text", required: true },
			createdAt: { type: "text", required: true },
			updatedAt: { type: "text", required: true },
			title: { type: "text" },
			status: { type: "select", options: ["draft", "published"] },
			views: { type: "number" },
			featured: { type: "boolean" },
			image: { type: "upload", relationTo: "media" },
		},
	};

	it("creates a table for each collection", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);

		expect(Object.keys(tables)).toEqual(["posts"]);
	});

	it("includes all field columns in the table", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);
		const { columns } = getTableConfig(tables.posts);
		const names = columns.map((c) => c.name);

		expect(names).toEqual([
			"id",
			"createdAt",
			"updatedAt",
			"title",
			"status",
			"views",
			"featured",
			"image",
		]);
	});

	it("maps field types to correct SQL types", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);
		const { columns } = getTableConfig(tables.posts);

		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.title.getSQLType()).toBe("text");
		expect(byName.status.getSQLType()).toBe("text");
		expect(byName.views.getSQLType()).toBe("integer");
		expect(byName.featured.getSQLType()).toBe("integer"); // ? boolean → integer in SQLite
		expect(byName.image.getSQLType()).toBe("text"); // ? upload ref → text
	});

	// ? ── Semantic column vocabulary (ROADMAP P0 #3) ─────────────────
	// ? Lock in the JS-shape contract: schema.ts must lower createdAt/updatedAt
	// ? to `timestamp`, boolean fields to `boolean`. SQLite's physical types
	// ? are `text` (ISO string) and `integer` (0/1) respectively — Payload-aligned.

	it("lowers createdAt/updatedAt to the timestamp builder (text on SQLite)", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);
		const { columns } = getTableConfig(tables.posts);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.createdAt.getSQLType()).toBe("text");
		expect(byName.updatedAt.getSQLType()).toBe("text");
	});

	it("lowers boolean fields via the boolean builder (integer on SQLite, mode:boolean)", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);
		const { columns } = getTableConfig(tables.posts);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		// ? still integer at the SQL level — semantic builder, dialect-internal mode flag
		expect(byName.featured.getSQLType()).toBe("integer");
	});

	it("lowers _sessions timestamps via the timestamp builder", () => {
		const authOnly: ResolvedCollectionConfig = {
			slug: "admins",
			auth: true,
			access: { ...openAccess, admin: allow },
			fields: {
				id: { type: "text", required: true },
				createdAt: { type: "text", required: true },
				updatedAt: { type: "text", required: true },
				email: { type: "text", required: true },
				hashedPassword: { type: "text", required: true },
			},
		};

		const tables = buildSchema([authOnly], sqliteConfig);
		const { columns } = getTableConfig(tables._sessions);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.expiresAt.getSQLType()).toBe("text");
		expect(byName.createdAt.getSQLType()).toBe("text");
	});

	it("applies correct constraints to system fields", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);
		const { columns } = getTableConfig(tables.posts);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.id.primary).toBe(true);
		expect(byName.createdAt.notNull).toBe(true);
		expect(byName.updatedAt.notNull).toBe(true);
	});

	// ? ── Localization ────────────────────────────────────────────

	const localizedCollection: ResolvedCollectionConfig = {
		slug: "pages",
		access: openAccess,
		hasLocalizedFields: true,
		fields: {
			id: { type: "text", required: true },
			createdAt: { type: "text", required: true },
			updatedAt: { type: "text", required: true },
			title: { type: "text", localized: true },
			slug: { type: "text" },
		},
	};

	const localization = {
		locales: ["en", "fr"] as [string, ...string[]],
		defaultLocale: "en",
	};

	it("does not create translation table without localization config", () => {
		const tables = buildSchema([localizedCollection], sqliteConfig);
		expect(tables.pages_translations).toBeUndefined();
	});

	it("does not create translation table when collection has no localized fields", () => {
		const nonLocalizedCollection: ResolvedCollectionConfig = {
			slug: "posts",
			access: openAccess,
			fields: {
				id: { type: "text", required: true },
				createdAt: { type: "text", required: true },
				updatedAt: { type: "text", required: true },
				title: { type: "text" },
			},
		};

		const tables = buildSchema(
			[nonLocalizedCollection],
			sqliteConfig,
			localization,
		);
		expect(tables.posts_translations).toBeUndefined();
	});

	it("creates translation table with correct columns", () => {
		const tables = buildSchema(
			[localizedCollection],
			sqliteConfig,
			localization,
		);

		expect(tables.pages_translations).toBeDefined();

		const { columns } = getTableConfig(tables.pages_translations);
		const names = columns.map((c) => c.name);

		// ? meta columns + only localized fields
		expect(names).toContain("id");
		expect(names).toContain("_parentId");
		expect(names).toContain("_locale");
		expect(names).toContain("title");

		// ? non-localized and system fields excluded
		expect(names).not.toContain("slug");
		expect(names).not.toContain("createdAt");
		expect(names).not.toContain("updatedAt");
	});

	it("applies unique constraint on (_parentId, _locale)", () => {
		const tables = buildSchema(
			[localizedCollection],
			sqliteConfig,
			localization,
		);

		const { uniqueConstraints } = getTableConfig(tables.pages_translations);
		expect(uniqueConstraints).toHaveLength(1);

		const colNames = uniqueConstraints[0].columns.map((c) => c.name);
		expect(colNames).toEqual(["_parentId", "_locale"]);
	});

	// ? ── Auth collections ────────────────────────────────────────

	const authCollection: ResolvedCollectionConfig = {
		slug: "admins",
		auth: true,
		access: { ...openAccess, admin: allow },
		fields: {
			id: { type: "text", required: true },
			createdAt: { type: "text", required: true },
			updatedAt: { type: "text", required: true },
			email: { type: "text", required: true },
			hashedPassword: { type: "text", required: true },
			name: { type: "text" },
		},
	};

	it("applies correct constraints to auth fields", () => {
		const tables = buildSchema([authCollection], sqliteConfig);
		const { columns } = getTableConfig(tables.admins);
		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.email.notNull).toBe(true);
		expect(byName.email.isUnique).toBe(true);
		expect(byName.hashedPassword.notNull).toBe(true);
	});

	it("creates _sessions table when auth collection exists", () => {
		const tables = buildSchema([authCollection], sqliteConfig);
		expect(tables._sessions).toBeDefined();

		const { columns } = getTableConfig(tables._sessions);
		const names = columns.map((c) => c.name);

		expect(names).toEqual(["id", "token", "userId", "expiresAt", "createdAt"]);

		const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

		expect(byName.id.primary).toBe(true);
		expect(byName.token.notNull).toBe(true);
		expect(byName.userId.notNull).toBe(true);
		expect(byName.expiresAt.notNull).toBe(true);
		expect(byName.createdAt.notNull).toBe(true);
	});

	it("does not create _sessions table when no auth collections exist", () => {
		const tables = buildSchema([postsCollection], sqliteConfig);
		expect(tables._sessions).toBeUndefined();
	});
});
