import Database from "better-sqlite3";
import type { ResolvedCollectionConfig } from "clay-cms";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	getTableConfig,
	integer,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CrudOperations } from "./crud.js";
import { createCrud } from "./crud.js";
import { buildSchema } from "./schema.js";
import type { SchemaBuilderConfig, TableMap } from "./types.js";

const timestamp = (name: string) => text(name);
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = (name: string) => text(name, { mode: "json" });

// ? typed narrowing helpers — CRUD methods return `unknown` / `unknown[]`, and
// ? sqlite `.all()` returns `unknown[]`. Per-collection asPost/asUser/asPage
// ? give field-name safety: a typo like `doc.tilte` becomes a TS error instead
// ? of silently returning undefined. The runtime guard rejects null/non-objects;
// ? the cast adds compile-time field shape mirroring the fixtures below.
type Row = Record<string, unknown>;

function asRow(d: unknown): Row {
	if (d === null || typeof d !== "object")
		throw new Error("expected row object");

	return d as Row;
}

// ? domain doc shapes — mirror the *Collection fixtures lower in this file.
// ? Optional `?` matches fields without `required: true` in the field config.
type Post = {
	id: string;
	createdAt: string;
	updatedAt: string;
	title?: string;
	status?: "draft" | "published";
};

type User = {
	id: string;
	createdAt: string;
	updatedAt: string;
	name?: string;
	role?: "admin" | "customer";
	email: string;
	hashedPassword?: string;
};

type Page = {
	id: string;
	createdAt: string;
	updatedAt: string;
	title?: string;
	slug?: string;
};

// ? raw sqlite row for the localized translation table — mirrors buildSchema.
type PageTranslationRow = {
	id: string;
	_parentId: string;
	_locale: string;
	title?: string;
};

function asPost(d: unknown): Post {
	return asRow(d) as unknown as Post;
}

function asPosts(d: unknown): Post[] {
	if (!Array.isArray(d)) throw new Error("expected posts array");

	return d.map(asPost);
}

function asUser(d: unknown): User {
	return asRow(d) as unknown as User;
}

function asUsers(d: unknown): User[] {
	if (!Array.isArray(d)) throw new Error("expected users array");

	return d.map(asUser);
}

function asPage(d: unknown): Page {
	return asRow(d) as unknown as Page;
}

function asPages(d: unknown): Page[] {
	if (!Array.isArray(d)) throw new Error("expected pages array");

	return d.map(asPage);
}

function asPageRows(d: unknown): Page[] {
	if (!Array.isArray(d)) throw new Error("expected sqlite pages rows");

	return d.map(asPage);
}

function asPageTranslationRows(d: unknown): PageTranslationRow[] {
	if (!Array.isArray(d)) throw new Error("expected sqlite translation rows");

	return d.map((r) => asRow(r) as unknown as PageTranslationRow);
}

const sqliteConfig: SchemaBuilderConfig = {
	tableFactory: sqliteTable,
	columns: { text, integer, real, boolean, timestamp, json },
	unique,
};

// ? permissive access stub for test fixtures — CRUD tests exercise the raw
// ? logic layer, not the proxy gate, so every op is allowed.
const allow = () => true;
const openAccess = {
	read: allow,
	create: allow,
	update: allow,
	delete: allow,
};

// ? Creates SQLite tables from drizzle schema objects.
// ? Uses getTableConfig to introspect the schema — so the test DB
// ? always matches what buildSchema() actually produces.
function createTablesInDb(
	sqlite: InstanceType<typeof Database>,
	tables: TableMap,
) {
	for (const table of Object.values(tables)) {
		const { name, columns, uniqueConstraints } = getTableConfig(table);

		const colDefs: string[] = columns.map((col) => {
			const parts = [`"${col.name}"`, col.getSQLType()];
			if (col.primary) parts.push("PRIMARY KEY");
			else if (col.notNull) parts.push("NOT NULL");
			if (col.isUnique) parts.push("UNIQUE");
			return parts.join(" ");
		});

		for (const uc of uniqueConstraints) {
			colDefs.push(
				`UNIQUE(${uc.columns.map((c: { name: string }) => `"${c.name}"`).join(", ")})`,
			);
		}

		sqlite.prepare(`CREATE TABLE "${name}" (${colDefs.join(", ")})`).run();
	}
}

// ? ── Test fixtures ───────────────────────────────────────────────

const postsCollection: ResolvedCollectionConfig = {
	slug: "posts",
	access: openAccess,
	fields: {
		id: { type: "text", required: true },
		createdAt: { type: "text", required: true },
		updatedAt: { type: "text", required: true },
		title: { type: "text" },
		status: { type: "select", options: ["draft", "published"] },
	},
};

const pagesCollection: ResolvedCollectionConfig = {
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

// ? ── Basic CRUD (no localization) ────────────────────────────────

describe("createCrud", () => {
	let sqlite: InstanceType<typeof Database>;
	let tables: TableMap;
	let crud: CrudOperations;

	describe("basic CRUD", () => {
		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([postsCollection], sqliteConfig);
			createTablesInDb(sqlite, tables);
			const db = drizzle(sqlite);
			crud = createCrud(db, tables, [postsCollection]);
		});

		afterEach(() => {
			sqlite.close();
		});

		it("creates a document with id and timestamps", async () => {
			const doc = asPost(
				await crud.create("posts", {
					data: {
						title: "Hello",
						status: "draft",
					},
				}),
			);

			expect(doc.title).toBe("Hello");
			expect(doc.status).toBe("draft");
			expect(doc.id).toBeDefined();
			expect(doc.createdAt).toBeDefined();
			expect(doc.updatedAt).toBeDefined();
		});

		it("finds all documents", async () => {
			await crud.create("posts", { data: { title: "Post 1" } });
			await crud.create("posts", { data: { title: "Post 2" } });

			const docs = await crud.find("posts");

			expect(docs).toHaveLength(2);
		});

		it("finds documents with a query filter", async () => {
			await crud.create("posts", { data: { title: "Draft", status: "draft" } });
			await crud.create("posts", {
				data: {
					title: "Published",
					status: "published",
				},
			});

			const docs = asPosts(
				await crud.find("posts", {
					where: {
						status: { equals: "published" },
					},
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.title).toBe("Published");
		});

		it("finds one document by id", async () => {
			const created = asPost(
				await crud.create("posts", { data: { title: "Test" } }),
			);

			const found = asPost(await crud.findOne("posts", { id: created.id }));

			expect(found.title).toBe("Test");
			expect(found.id).toBe(created.id);
		});

		it("returns null for non-existent id", async () => {
			const found = await crud.findOne("posts", { id: "nonexistent" });

			expect(found).toBeNull();
		});

		it("updates a document and bumps updatedAt", async () => {
			const created = asPost(
				await crud.create("posts", { data: { title: "Original" } }),
			);

			// ? small delay so updatedAt differs
			await new Promise((r) => setTimeout(r, 5));

			const updated = asPost(
				await crud.update("posts", {
					id: created.id,
					data: { title: "Updated" },
				}),
			);

			expect(updated.title).toBe("Updated");
			expect(updated.updatedAt).not.toBe(created.updatedAt);
		});

		it("deletes a document", async () => {
			const created = asPost(
				await crud.create("posts", { data: { title: "To delete" } }),
			);

			await crud.delete("posts", { id: created.id });

			const found = await crud.findOne("posts", { id: created.id });

			expect(found).toBeNull();
		});

		it("throws for unknown collection", async () => {
			await expect(crud.find("nonexistent")).rejects.toThrow(
				'Unknown collection: "nonexistent"',
			);
		});
	});

	// ? ── Field projection (select) ─────────────────────────────────

	describe("select projection", () => {
		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([postsCollection], sqliteConfig);
			createTablesInDb(sqlite, tables);
			const db = drizzle(sqlite);
			crud = createCrud(db, tables, [postsCollection]);
		});

		afterEach(() => {
			sqlite.close();
		});

		it("include mode returns only listed fields plus system fields", async () => {
			await crud.create("posts", {
				data: { title: "Hello", status: "draft" },
			});

			const docs = asPosts(
				await crud.find("posts", { select: { title: true } }),
			);

			expect(docs).toHaveLength(1);
			const doc = docs[0] as Record<string, unknown>;

			expect(doc).toHaveProperty("title", "Hello");
			expect(doc).toHaveProperty("id");
			expect(doc).toHaveProperty("createdAt");
			expect(doc).toHaveProperty("updatedAt");
			expect(doc).not.toHaveProperty("status");
		});

		it("exclude mode omits listed fields, keeps everything else", async () => {
			await crud.create("posts", {
				data: { title: "Hello", status: "published" },
			});

			const docs = asPosts(
				await crud.find("posts", { select: { status: false } }),
			);

			expect(docs).toHaveLength(1);
			const doc = docs[0] as Record<string, unknown>;

			expect(doc).toHaveProperty("title", "Hello");
			expect(doc).toHaveProperty("id");
			expect(doc).not.toHaveProperty("status");
		});

		it("findOne projects the same way as find", async () => {
			const created = asPost(
				await crud.create("posts", {
					data: { title: "Hello", status: "draft" },
				}),
			);

			const doc = await crud.findOne("posts", {
				id: created.id,
				select: { title: true },
			});

			expect(doc).toBeTruthy();
			const obj = doc as Record<string, unknown>;
			expect(obj).toHaveProperty("title", "Hello");
			expect(obj).toHaveProperty("id");
			expect(obj).not.toHaveProperty("status");
		});

		it("system fields can be explicitly excluded", async () => {
			await crud.create("posts", { data: { title: "Hello" } });

			const docs = asPosts(
				await crud.find("posts", { select: { createdAt: false } }),
			);

			const doc = docs[0] as Record<string, unknown>;

			expect(doc).not.toHaveProperty("createdAt");
			expect(doc).toHaveProperty("id");
			expect(doc).toHaveProperty("title");
		});

		it("select still applies the where filter", async () => {
			await crud.create("posts", {
				data: { title: "Draft", status: "draft" },
			});
			await crud.create("posts", {
				data: { title: "Published", status: "published" },
			});

			const docs = asPosts(
				await crud.find("posts", {
					where: { status: { equals: "published" } },
					select: { title: true },
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.title).toBe("Published");
		});

		it("throws when select mixes include and exclude modes", async () => {
			await expect(
				crud.find("posts", {
					select: { title: true, status: false } as Record<string, boolean>,
				}),
			).rejects.toThrow(/cannot mix include .* and exclude/);
		});
	});

	// ? ── select skip-join (localized collections) ──────────────────

	describe("select skip-join on localized collections", () => {
		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([pagesCollection], sqliteConfig, localization);
			createTablesInDb(sqlite, tables);
			const db = drizzle(sqlite);
			crud = createCrud(db, tables, [pagesCollection], localization);
		});

		afterEach(() => {
			sqlite.close();
		});

		it("non-default locale + select with no localized field skips the JOIN entirely", async () => {
			// ? Drop the translations table after creation. If the JOIN is taken
			// ? the query will throw "no such table"; if skipJoin works the
			// ? non-localized fields come back from the main table alone.
			await crud.create("pages", {
				data: { title: "Home", slug: "home" },
			});
			await crud.update("pages", {
				id: (asPages(await crud.find("pages"))[0] as Page).id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			sqlite.prepare('DROP TABLE "pages_translations"').run();

			// ? Selecting only `slug` (non-localized) — projection.skipJoin = true
			const docs = asPages(
				await crud.find("pages", {
					locale: "fr",
					select: { slug: true },
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.slug).toBe("home");
			expect(docs[0]).not.toHaveProperty("title");
		});

		it("non-default locale + select including a localized field still runs the JOIN + overlay", async () => {
			const created = asPage(
				await crud.create("pages", {
					data: { title: "Home", slug: "home" },
				}),
			);

			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			const docs = asPages(
				await crud.find("pages", {
					locale: "fr",
					select: { title: true, slug: true },
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.title).toBe("Accueil"); // ? overlay applied
			expect(docs[0]?.slug).toBe("home");
		});
	});

	// ? ── Hidden fields ──────────────────────────────────────────

	describe("hidden fields", () => {
		const usersCollection: ResolvedCollectionConfig = {
			slug: "users",
			auth: true,
			access: { ...openAccess, admin: allow },
			fields: {
				id: { type: "text", required: true },
				createdAt: { type: "text", required: true },
				updatedAt: { type: "text", required: true },
				name: { type: "text" },
				email: { type: "text", required: true },
				hashedPassword: { type: "text", required: true, hidden: true },
			},
		};

		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([usersCollection], sqliteConfig);

			createTablesInDb(sqlite, tables);

			const db = drizzle(sqlite);
			crud = createCrud(db, tables, [usersCollection]);
		});

		afterEach(() => {
			sqlite.close();
		});

		it("find strips hidden fields by default", async () => {
			await crud.create("users", {
				data: {
					name: "Alice",
					email: "alice@example.com",
					hashedPassword: "$2a$10$fakehash",
				},
			});

			const docs = asUsers(await crud.find("users"));

			expect(docs).toHaveLength(1);
			expect(docs[0]?.name).toBe("Alice");
			expect(docs[0]?.email).toBe("alice@example.com");
			expect(docs[0]).not.toHaveProperty("hashedPassword");
		});

		it("find returns hidden fields when showHiddenFields is true", async () => {
			await crud.create("users", {
				data: {
					name: "Alice",
					email: "alice@example.com",
					hashedPassword: "$2a$10$fakehash",
				},
			});

			const docs = asUsers(
				await crud.find("users", { showHiddenFields: true }),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.hashedPassword).toBe("$2a$10$fakehash");
		});

		it("find with query strips hidden fields by default", async () => {
			await crud.create("users", {
				data: {
					name: "Alice",
					email: "alice@example.com",
					hashedPassword: "$2a$10$fakehash",
				},
			});

			const docs = asUsers(
				await crud.find("users", {
					where: {
						email: { equals: "alice@example.com" },
					},
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]).not.toHaveProperty("hashedPassword");
		});

		it("findOne strips hidden fields by default", async () => {
			const created = asUser(
				await crud.create("users", {
					data: {
						name: "Alice",
						email: "alice@example.com",
						hashedPassword: "$2a$10$fakehash",
					},
				}),
			);

			const doc = asUser(await crud.findOne("users", { id: created.id }));

			expect(doc.name).toBe("Alice");
			expect(doc).not.toHaveProperty("hashedPassword");
		});

		it("findOne returns hidden fields when showHiddenFields is true", async () => {
			const created = asUser(
				await crud.create("users", {
					data: {
						name: "Alice",
						email: "alice@example.com",
						hashedPassword: "$2a$10$fakehash",
					},
				}),
			);

			const doc = asUser(
				await crud.findOne("users", { id: created.id, showHiddenFields: true }),
			);

			expect(doc.hashedPassword).toBe("$2a$10$fakehash");
		});
	});

	// ? ── Guarded writes — atomic race invariants (ROADMAP P0 security) ──
	// ? These pin the real SQL behind the security-hardening race fixes against
	// ? a live SQLite. The proxy/policy is unit-tested in clay-cms api.spec.ts;
	// ? here we prove the WHERE-embedded guards actually refuse the losing write.
	describe("guarded writes — race invariants", () => {
		const usersCollection: ResolvedCollectionConfig = {
			slug: "users",
			auth: true,
			access: { ...openAccess, admin: allow },
			fields: {
				id: { type: "text", required: true },
				createdAt: { type: "text", required: true },
				updatedAt: { type: "text", required: true },
				name: { type: "text" },
				role: { type: "select", options: ["admin", "customer"] },
				email: { type: "text", required: true },
				hashedPassword: { type: "text", required: true, hidden: true },
			},
		};

		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([usersCollection], sqliteConfig);
			createTablesInDb(sqlite, tables);
			const db = drizzle(sqlite);
			crud = createCrud(db, tables, [usersCollection]);
		});

		afterEach(() => {
			sqlite.close();
		});

		// ? requireEmpty (first-user setup singleton) ──────────────────
		it("create requireEmpty inserts into an empty table", async () => {
			const doc = asUser(
				await crud.create("users", {
					data: {
						name: "First",
						email: "first@example.com",
						hashedPassword: "h",
						role: "admin",
					},
					requireEmpty: true,
				}),
			);

			expect(doc.id).toBeDefined();
			expect(doc.email).toBe("first@example.com");
			expect(await crud.find("users")).toHaveLength(1);
		});

		it("create requireEmpty returns null once a row exists (no second insert)", async () => {
			await crud.create("users", {
				data: {
					name: "First",
					email: "first@example.com",
					hashedPassword: "h",
				},
				requireEmpty: true,
			});

			const second = await crud.create("users", {
				data: {
					name: "Second",
					email: "second@example.com",
					hashedPassword: "h",
				},
				requireEmpty: true,
			});

			expect(second).toBeNull();
			expect(await crud.find("users")).toHaveLength(1);
		});

		// ? requireOther on delete (last-user invariant) ───────────────
		it("delete requireOther removes a row when another exists, returns true", async () => {
			const a = asUser(
				await crud.create("users", {
					data: { email: "a@example.com", hashedPassword: "h" },
				}),
			);
			await crud.create("users", {
				data: { email: "b@example.com", hashedPassword: "h" },
			});

			const deleted = await crud.delete("users", {
				id: a.id,
				requireOther: {},
			});

			expect(deleted).toBe(true);
			expect(await crud.find("users")).toHaveLength(1);
		});

		it("delete requireOther refuses the last row, returns false (no delete)", async () => {
			const only = asUser(
				await crud.create("users", {
					data: { email: "only@example.com", hashedPassword: "h" },
				}),
			);

			const deleted = await crud.delete("users", {
				id: only.id,
				requireOther: {},
			});

			expect(deleted).toBe(false);
			expect(await crud.find("users")).toHaveLength(1);
		});

		// ? requireOther on update (last-admin demote invariant) ───────
		it("update requireOther demotes when another admin remains", async () => {
			const a = asUser(
				await crud.create("users", {
					data: { email: "a@example.com", hashedPassword: "h", role: "admin" },
				}),
			);
			await crud.create("users", {
				data: { email: "b@example.com", hashedPassword: "h", role: "admin" },
			});

			const updated = asUser(
				await crud.update("users", {
					id: a.id,
					data: { role: "customer" },
					requireOther: { where: { role: { equals: "admin" } } },
				}),
			);

			expect(updated.role).toBe("customer");
		});

		it("update requireOther refuses to demote the last admin (returns undefined)", async () => {
			const only = asUser(
				await crud.create("users", {
					data: {
						email: "only@example.com",
						hashedPassword: "h",
						role: "admin",
					},
				}),
			);
			// ? a non-admin exists, but no OTHER admin does
			await crud.create("users", {
				data: { email: "c@example.com", hashedPassword: "h", role: "customer" },
			});

			const result = await crud.update("users", {
				id: only.id,
				data: { role: "customer" },
				requireOther: { where: { role: { equals: "admin" } } },
			});

			expect(result).toBeUndefined();

			// ? the row is untouched — still admin
			const reloaded = asUser(
				await crud.findOne("users", { id: only.id, showHiddenFields: true }),
			);
			expect(reloaded.role).toBe("admin");
		});
	});

	// ? ── Localized CRUD ──────────────────────────────────────────

	describe("localized CRUD", () => {
		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([pagesCollection], sqliteConfig, localization);

			createTablesInDb(sqlite, tables);

			const db = drizzle(sqlite);
			crud = createCrud(db, tables, [pagesCollection], localization);
		});

		afterEach(() => {
			sqlite.close();
		});

		it("creates with default locale — stores on main table only", async () => {
			const doc = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			expect(doc.title).toBe("Home");
			expect(doc.slug).toBe("home");

			// ? translation table should be empty
			const rows = sqlite.prepare('SELECT * FROM "pages_translations"').all();
			expect(rows).toHaveLength(0);
		});

		it("creates with non-default locale — splits data into main + translation", async () => {
			const doc = asPage(
				await crud.create("pages", {
					data: { title: "Accueil", slug: "home" },
					locale: "fr",
				}),
			);

			expect(doc.slug).toBe("home");
			expect(doc.title).toBe("Accueil");

			// ? main table should have the non-localized fields
			const mainRows = asPageRows(
				sqlite.prepare('SELECT * FROM "pages"').all(),
			);

			expect(mainRows).toHaveLength(1);
			expect(mainRows[0]?.slug).toBe("home");

			// ? translation table should have the localized field
			const transRows = asPageTranslationRows(
				sqlite.prepare('SELECT * FROM "pages_translations"').all(),
			);

			expect(transRows).toHaveLength(1);
			expect(transRows[0]?._locale).toBe("fr");
			expect(transRows[0]?.title).toBe("Accueil");
		});

		it("reads with non-default locale — overlays translation onto base row", async () => {
			// ? create in default locale
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			// ? add French translation
			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			// ? read in French
			const doc = asPage(
				await crud.findOne("pages", { id: created.id, locale: "fr" }),
			);

			expect(doc.title).toBe("Accueil"); // ? translated
			expect(doc.slug).toBe("home"); // ? base value preserved
		});

		it("find with non-default locale — overlays translations", async () => {
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			const docs = asPages(await crud.find("pages", { locale: "fr" }));

			expect(docs).toHaveLength(1);
			expect(docs[0]?.title).toBe("Accueil");
			expect(docs[0]?.slug).toBe("home");
		});

		it("findOne with default locale — returns base row without join", async () => {
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			// ? read in default locale — should get base value
			const doc = asPage(
				await crud.findOne("pages", { id: created.id, locale: "en" }),
			);
			expect(doc.title).toBe("Home");
		});

		it("update with non-default locale — upserts translation row", async () => {
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			// ? first French update — inserts translation
			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			let transRows = asPageTranslationRows(
				sqlite.prepare('SELECT * FROM "pages_translations"').all(),
			);

			expect(transRows).toHaveLength(1);

			// ? second French update — upserts (same row count)
			await crud.update("pages", {
				id: created.id,
				data: { title: "Page d'accueil" },
				locale: "fr",
			});

			transRows = asPageTranslationRows(
				sqlite.prepare('SELECT * FROM "pages_translations"').all(),
			);

			expect(transRows).toHaveLength(1);
			expect(transRows[0]?.title).toBe("Page d'accueil");
		});

		// ? ── localized find + where (the JOIN integration gap) ──
		// ? these are the cases the audit flagged: until now overlay and where were
		// ? tested separately, never together. The where filter must apply through
		// ? the LEFT JOIN against the base table, and the overlay must still run on
		// ? the matching rows.

		it("find with where + non-default locale — filter on non-localized field + overlay", async () => {
			const a = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			const b = asPage(
				await crud.create("pages", { data: { title: "About", slug: "about" } }),
			);

			await crud.update("pages", {
				id: a.id,
				data: { title: "Accueil" },
				locale: "fr",
			});
			await crud.update("pages", {
				id: b.id,
				data: { title: "À propos" },
				locale: "fr",
			});

			// ? filter on the non-localized `slug` column, read in French
			const docs = asPages(
				await crud.find("pages", {
					where: { slug: { equals: "home" } },
					locale: "fr",
				}),
			);

			expect(docs).toHaveLength(1);

			// ? overlay still applies to the filtered row
			expect(docs[0]?.title).toBe("Accueil");
			expect(docs[0]?.slug).toBe("home");
		});

		it("find with where + non-default locale — empty match returns []", async () => {
			await crud.create("pages", { data: { title: "Home", slug: "home" } });

			const docs = asPages(
				await crud.find("pages", {
					where: { slug: { equals: "nonexistent" } },
					locale: "fr",
				}),
			);

			expect(docs).toEqual([]);
		});

		it("find with where + non-default locale — and/or combinator works through JOIN", async () => {
			await crud.create("pages", { data: { title: "Home", slug: "home" } });
			await crud.create("pages", { data: { title: "About", slug: "about" } });
			await crud.create("pages", {
				data: { title: "Contact", slug: "contact" },
			});

			const docs = asPages(
				await crud.find("pages", {
					where: {
						or: [{ slug: { equals: "home" } }, { slug: { equals: "about" } }],
					},
					locale: "fr",
				}),
			);

			expect(docs.map((d) => d.slug).sort()).toEqual(["about", "home"]);
		});

		it("find with where on a localized field in non-default locale — known limitation: filters base value", async () => {
			// ? CLAUDE.md: "non-default-locale _translations joins in whereToDrizzle are a known follow-up"
			// ? Today the where filter is built against the BASE table column, so filtering
			// ? on a localized field in non-default locale matches the *default locale* value.
			// ? Pin this behavior so the day a real fix lands, this test trips as a reminder.
			const a = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			await crud.update("pages", {
				id: a.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			// ? matches against base-table `title = "Home"` (the default-locale value),
			// ? not against the French translation. Overlay still rewrites the result.
			const matchByBase = asPages(
				await crud.find("pages", {
					where: { title: { equals: "Home" } },
					locale: "fr",
				}),
			);

			expect(matchByBase).toHaveLength(1);
			expect(matchByBase[0]?.title).toBe("Accueil"); // ? overlay runs

			// ? searching for the French value finds nothing — proof we're filtering on base
			const matchByFr = asPages(
				await crud.find("pages", {
					where: { title: { equals: "Accueil" } },
					locale: "fr",
				}),
			);

			expect(matchByFr).toEqual([]);
		});

		it("delete removes both main row and translations", async () => {
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});
			await crud.delete("pages", { id: created.id });

			expect(await crud.findOne("pages", { id: created.id })).toBeNull();

			const transRows = sqlite
				.prepare('SELECT * FROM "pages_translations"')
				.all();

			expect(transRows).toHaveLength(0);
		});
	});

	// ? ── db.batch() routing for localized writes ─────────────────────
	// ? Better-sqlite3 has no native .batch() — but D1 does, and that's
	// ? where we actually need atomicity (orphan-row corruption fixed by
	// ? ROADMAP P0 #4). Wrap the drizzle db in a thin shim that exposes a
	// ? .batch() recording its calls and executes the statements
	// ? sequentially. Asserts CRUD routes through batch when available.

	describe("localized writes via db.batch", () => {
		let sqlite: InstanceType<typeof Database>;
		let tables: TableMap;
		let crud: CrudOperations;
		let batchCalls: number;

		beforeEach(() => {
			sqlite = new Database(":memory:");
			tables = buildSchema([pagesCollection], sqliteConfig, localization);
			createTablesInDb(sqlite, tables);

			const realDb = drizzle(sqlite);
			batchCalls = 0;

			// ? proxy realDb so .batch is present and counted; everything else
			// ? falls through unchanged. drizzle queries are thenable, so
			// ? awaiting them sequentially mirrors what D1's atomic batch does
			// ? in the success case (the test is about routing, not atomicity).
			const batchedDb = new Proxy(realDb, {
				get(target, prop, receiver) {
					if (prop === "batch") {
						return async (stmts: PromiseLike<unknown>[]) => {
							batchCalls += 1;
							const out: unknown[] = [];
							for (const s of stmts) out.push(await s);
							return out;
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			});

			crud = createCrud(
				batchedDb as unknown as typeof realDb,
				tables,
				[pagesCollection],
				localization,
			);
		});

		afterEach(() => {
			sqlite.close();
		});

		it("create with non-default locale routes through db.batch", async () => {
			const doc = asPage(
				await crud.create("pages", {
					data: { title: "Accueil", slug: "home" },
					locale: "fr",
				}),
			);

			expect(batchCalls).toBe(1);
			expect(doc.title).toBe("Accueil");
			expect(doc.slug).toBe("home");

			// ? both rows actually landed
			expect(
				asPageRows(sqlite.prepare('SELECT * FROM "pages"').all()),
			).toHaveLength(1);
			expect(
				asPageTranslationRows(
					sqlite.prepare('SELECT * FROM "pages_translations"').all(),
				),
			).toHaveLength(1);
		});

		it("update with non-default locale routes through db.batch when both main + translation change", async () => {
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);

			batchCalls = 0;

			// ? mainData (slug) + translationData (title) both present → batched
			await crud.update("pages", {
				id: created.id,
				data: { slug: "home-fr", title: "Accueil" },
				locale: "fr",
			});

			expect(batchCalls).toBe(1);
		});

		it("delete with translations routes through db.batch", async () => {
			const created = asPage(
				await crud.create("pages", { data: { title: "Home", slug: "home" } }),
			);
			await crud.update("pages", {
				id: created.id,
				data: { title: "Accueil" },
				locale: "fr",
			});

			batchCalls = 0;
			await crud.delete("pages", { id: created.id });

			expect(batchCalls).toBe(1);
			expect(await crud.findOne("pages", { id: created.id })).toBeNull();
			expect(
				asPageTranslationRows(
					sqlite.prepare('SELECT * FROM "pages_translations"').all(),
				),
			).toHaveLength(0);
		});
	});
});

// ? ── db.batch atomicity: orphan-row rollback (ROADMAP P0 #4) ──────────
// ? The routing test above proves both statements go through db.batch. This
// ? proves the POINT of batching: when the second (translation) write fails,
// ? the first (main-row) write rolls back — no orphaned main row survives.
// ? The shim wraps the batched statements in a real SQLite transaction, which
// ? is exactly the atomicity D1's native batch provides in production.
describe("createCrud — localized writes are atomic (orphan-row rollback)", () => {
	let sqlite: InstanceType<typeof Database>;
	let crud: CrudOperations;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		const tables = buildSchema([pagesCollection], sqliteConfig, localization);
		createTablesInDb(sqlite, tables);

		const realDb = drizzle(sqlite);

		// ? atomic batch shim: run every statement inside one SQLite transaction,
		// ? rolling back the lot if any throws — the behaviour D1's batch guarantees.
		const atomicDb = new Proxy(realDb, {
			get(target, prop, receiver) {
				if (prop === "batch") {
					return async (stmts: PromiseLike<unknown>[]) => {
						sqlite.exec("BEGIN");
						try {
							const out: unknown[] = [];
							for (const s of stmts) out.push(await s);
							sqlite.exec("COMMIT");
							return out;
						} catch (err) {
							sqlite.exec("ROLLBACK");
							throw err;
						}
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		crud = createCrud(
			atomicDb as unknown as typeof realDb,
			tables,
			[pagesCollection],
			localization,
		);
	});

	afterEach(() => sqlite.close());

	it("rolls back the main-row insert when the translation write fails", async () => {
		// ? force the second batched statement to fail — drop the table it targets.
		sqlite.exec('DROP TABLE "pages_translations"');

		await expect(
			crud.create("pages", {
				data: { title: "Accueil", slug: "home" },
				locale: "fr",
			}),
		).rejects.toThrow();

		// ? the main row must NOT have landed — the batch rolled everything back.
		// ? Pre-P0-#4 (two sequential awaits) this left an orphaned main row.
		expect(
			asPageRows(sqlite.prepare('SELECT * FROM "pages"').all()),
		).toHaveLength(0);
	});
});

// ? ── July 2026 multi-agent review — regression pins ──────────────────
describe("createCrud — July 2026 review regressions", () => {
	let sqlite: InstanceType<typeof Database>;

	function setup(cols: ResolvedCollectionConfig[]): CrudOperations {
		sqlite = new Database(":memory:");
		const tables = buildSchema(cols, sqliteConfig, localization);
		createTablesInDb(sqlite, tables);
		return createCrud(drizzle(sqlite), tables, cols, localization);
	}

	afterEach(() => sqlite.close());

	// ? default-locale select of a LOCALIZED field must return that field —
	// ? resolveSelect used to drop localized columns from the main-table select.
	it("default-locale select returns a localized field (was silently dropped)", async () => {
		const crud = setup([pagesCollection]);
		await crud.create("pages", { data: { title: "Home", slug: "home" } });

		const [row] = asPages(
			await crud.find("pages", { select: { title: true } }),
		);

		expect(row?.title).toBe("Home");
		// ? non-selected non-system field omitted
		expect(row?.slug).toBeUndefined();
	});

	// ? requireEmpty must encode values through the column's driver mapper —
	// ? a boolean would otherwise fail to bind on the raw INSERT…SELECT path.
	it("create requireEmpty encodes a boolean field (no bind error, round-trips)", async () => {
		const flags: ResolvedCollectionConfig = {
			slug: "flags",
			access: openAccess,
			fields: {
				id: { type: "text", required: true },
				createdAt: { type: "text", required: true },
				updatedAt: { type: "text", required: true },
				name: { type: "text" },
				active: { type: "boolean" },
			},
		};
		const crud = setup([flags]);

		const created = asRow(
			await crud.create("flags", {
				data: { name: "x", active: true },
				requireEmpty: true,
			}),
		);

		expect(created.active).toBe(true);
		const reloaded = asRow(
			await crud.findOne("flags", { id: created.id as string }),
		);
		expect(reloaded.active).toBe(true);
	});

	// ? the last-admin demote guard (requireOther) must hold even when a
	// ? non-default `locale` is passed — the localized update branch used to
	// ? ignore requireOther, so `locale: "fr"` bypassed the invariant entirely.
	it("update requireOther is honored with a non-default locale set (locale-bypass fix)", async () => {
		const members: ResolvedCollectionConfig = {
			slug: "members",
			auth: true,
			hasLocalizedFields: true,
			access: { ...openAccess, admin: allow },
			fields: {
				id: { type: "text", required: true },
				createdAt: { type: "text", required: true },
				updatedAt: { type: "text", required: true },
				role: { type: "select", options: ["admin", "customer"] },
				email: { type: "text", required: true },
				bio: { type: "text", localized: true },
			},
		};
		const crud = setup([members]);

		const only = asRow(
			await crud.create("members", {
				data: { email: "a@x.com", role: "admin" },
			}),
		);
		await crud.create("members", {
			data: { email: "b@x.com", role: "customer" },
		});

		// ? demote the ONLY admin, in French — must be refused (returns undefined)
		const result = await crud.update("members", {
			id: only.id as string,
			data: { role: "customer" },
			locale: "fr",
			requireOther: { where: { role: { equals: "admin" } } },
		});

		expect(result).toBeUndefined();
		const reloaded = asRow(
			await crud.findOne("members", { id: only.id as string }),
		);
		expect(reloaded.role).toBe("admin");
	});

	// ? not_equals / not_in must be NULL-inclusive in SQL, matching matchesWhere,
	// ? so find() and the single-doc gate agree on the same ACL Where.
	it("not_equals includes NULL-valued rows (parity with matchesWhere)", async () => {
		const crud = setup([
			{
				slug: "posts",
				access: openAccess,
				fields: {
					id: { type: "text", required: true },
					createdAt: { type: "text", required: true },
					updatedAt: { type: "text", required: true },
					status: { type: "select", options: ["draft", "published"] },
				},
			},
		]);

		await crud.create("posts", { data: { status: "published" } });
		await crud.create("posts", { data: {} }); // ? status is NULL

		const rows = asPosts(
			await crud.find("posts", {
				where: { status: { not_equals: "published" } },
			}),
		);

		// ? the NULL-status row matches (SQLite `col != 'x'` alone would exclude it)
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status ?? null).toBeNull();
	});
});
