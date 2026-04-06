import Database from "better-sqlite3";
import type { ResolvedCollectionConfig } from "clay-cms";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	getTableConfig,
	integer,
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
	columns: { text, integer, boolean, timestamp, json },
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
					title: "Hello",
					status: "draft",
				}),
			);

			expect(doc.title).toBe("Hello");
			expect(doc.status).toBe("draft");
			expect(doc.id).toBeDefined();
			expect(doc.createdAt).toBeDefined();
			expect(doc.updatedAt).toBeDefined();
		});

		it("finds all documents", async () => {
			await crud.create("posts", { title: "Post 1" });
			await crud.create("posts", { title: "Post 2" });

			const docs = await crud.find("posts");

			expect(docs).toHaveLength(2);
		});

		it("finds documents with a query filter", async () => {
			await crud.create("posts", { title: "Draft", status: "draft" });
			await crud.create("posts", {
				title: "Published",
				status: "published",
			});

			const docs = asPosts(
				await crud.find("posts", {
					status: { equals: "published" },
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.title).toBe("Published");
		});

		it("finds one document by id", async () => {
			const created = asPost(await crud.create("posts", { title: "Test" }));

			const found = asPost(await crud.findOne("posts", created.id));

			expect(found.title).toBe("Test");
			expect(found.id).toBe(created.id);
		});

		it("returns null for non-existent id", async () => {
			const found = await crud.findOne("posts", "nonexistent");

			expect(found).toBeNull();
		});

		it("updates a document and bumps updatedAt", async () => {
			const created = asPost(await crud.create("posts", { title: "Original" }));

			// ? small delay so updatedAt differs
			await new Promise((r) => setTimeout(r, 5));

			const updated = asPost(
				await crud.update("posts", created.id, { title: "Updated" }),
			);

			expect(updated.title).toBe("Updated");
			expect(updated.updatedAt).not.toBe(created.updatedAt);
		});

		it("deletes a document", async () => {
			const created = asPost(
				await crud.create("posts", { title: "To delete" }),
			);

			await crud.delete("posts", created.id);

			const found = await crud.findOne("posts", created.id);

			expect(found).toBeNull();
		});

		it("throws for unknown collection", async () => {
			await expect(crud.find("nonexistent")).rejects.toThrow(
				'Unknown collection: "nonexistent"',
			);
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
				name: "Alice",
				email: "alice@example.com",
				hashedPassword: "$2a$10$fakehash",
			});

			const docs = asUsers(await crud.find("users"));

			expect(docs).toHaveLength(1);
			expect(docs[0]?.name).toBe("Alice");
			expect(docs[0]?.email).toBe("alice@example.com");
			expect(docs[0]).not.toHaveProperty("hashedPassword");
		});

		it("find returns hidden fields when showHiddenFields is true", async () => {
			await crud.create("users", {
				name: "Alice",
				email: "alice@example.com",
				hashedPassword: "$2a$10$fakehash",
			});

			const docs = asUsers(
				await crud.find("users", undefined, undefined, true),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]?.hashedPassword).toBe("$2a$10$fakehash");
		});

		it("find with query strips hidden fields by default", async () => {
			await crud.create("users", {
				name: "Alice",
				email: "alice@example.com",
				hashedPassword: "$2a$10$fakehash",
			});

			const docs = asUsers(
				await crud.find("users", {
					email: { equals: "alice@example.com" },
				}),
			);

			expect(docs).toHaveLength(1);
			expect(docs[0]).not.toHaveProperty("hashedPassword");
		});

		it("findOne strips hidden fields by default", async () => {
			const created = asUser(
				await crud.create("users", {
					name: "Alice",
					email: "alice@example.com",
					hashedPassword: "$2a$10$fakehash",
				}),
			);

			const doc = asUser(await crud.findOne("users", created.id));

			expect(doc.name).toBe("Alice");
			expect(doc).not.toHaveProperty("hashedPassword");
		});

		it("findOne returns hidden fields when showHiddenFields is true", async () => {
			const created = asUser(
				await crud.create("users", {
					name: "Alice",
					email: "alice@example.com",
					hashedPassword: "$2a$10$fakehash",
				}),
			);

			const doc = asUser(
				await crud.findOne("users", created.id, undefined, true),
			);

			expect(doc.hashedPassword).toBe("$2a$10$fakehash");
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
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			expect(doc.title).toBe("Home");
			expect(doc.slug).toBe("home");

			// ? translation table should be empty
			const rows = sqlite.prepare('SELECT * FROM "pages_translations"').all();
			expect(rows).toHaveLength(0);
		});

		it("creates with non-default locale — splits data into main + translation", async () => {
			const doc = asPage(
				await crud.create("pages", { title: "Accueil", slug: "home" }, "fr"),
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
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			// ? add French translation
			await crud.update("pages", created.id, { title: "Accueil" }, "fr");

			// ? read in French
			const doc = asPage(await crud.findOne("pages", created.id, "fr"));

			expect(doc.title).toBe("Accueil"); // ? translated
			expect(doc.slug).toBe("home"); // ? base value preserved
		});

		it("find with non-default locale — overlays translations", async () => {
			const created = asPage(
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			await crud.update("pages", created.id, { title: "Accueil" }, "fr");

			const docs = asPages(await crud.find("pages", undefined, "fr"));

			expect(docs).toHaveLength(1);
			expect(docs[0]?.title).toBe("Accueil");
			expect(docs[0]?.slug).toBe("home");
		});

		it("findOne with default locale — returns base row without join", async () => {
			const created = asPage(
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			await crud.update("pages", created.id, { title: "Accueil" }, "fr");

			// ? read in default locale — should get base value
			const doc = asPage(await crud.findOne("pages", created.id, "en"));
			expect(doc.title).toBe("Home");
		});

		it("update with non-default locale — upserts translation row", async () => {
			const created = asPage(
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			// ? first French update — inserts translation
			await crud.update("pages", created.id, { title: "Accueil" }, "fr");

			let transRows = asPageTranslationRows(
				sqlite.prepare('SELECT * FROM "pages_translations"').all(),
			);

			expect(transRows).toHaveLength(1);

			// ? second French update — upserts (same row count)
			await crud.update("pages", created.id, { title: "Page d'accueil" }, "fr");

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
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			const b = asPage(
				await crud.create("pages", { title: "About", slug: "about" }),
			);

			await crud.update("pages", a.id, { title: "Accueil" }, "fr");
			await crud.update("pages", b.id, { title: "À propos" }, "fr");

			// ? filter on the non-localized `slug` column, read in French
			const docs = asPages(
				await crud.find("pages", { slug: { equals: "home" } }, "fr"),
			);

			expect(docs).toHaveLength(1);

			// ? overlay still applies to the filtered row
			expect(docs[0]?.title).toBe("Accueil");
			expect(docs[0]?.slug).toBe("home");
		});

		it("find with where + non-default locale — empty match returns []", async () => {
			await crud.create("pages", { title: "Home", slug: "home" });

			const docs = asPages(
				await crud.find("pages", { slug: { equals: "nonexistent" } }, "fr"),
			);

			expect(docs).toEqual([]);
		});

		it("find with where + non-default locale — and/or combinator works through JOIN", async () => {
			await crud.create("pages", { title: "Home", slug: "home" });
			await crud.create("pages", { title: "About", slug: "about" });
			await crud.create("pages", { title: "Contact", slug: "contact" });

			const docs = asPages(
				await crud.find(
					"pages",
					{
						or: [{ slug: { equals: "home" } }, { slug: { equals: "about" } }],
					},
					"fr",
				),
			);

			expect(docs.map((d) => d.slug).sort()).toEqual(["about", "home"]);
		});

		it("find with where on a localized field in non-default locale — known limitation: filters base value", async () => {
			// ? CLAUDE.md: "non-default-locale _translations joins in whereToDrizzle are a known follow-up"
			// ? Today the where filter is built against the BASE table column, so filtering
			// ? on a localized field in non-default locale matches the *default locale* value.
			// ? Pin this behavior so the day a real fix lands, this test trips as a reminder.
			const a = asPage(
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			await crud.update("pages", a.id, { title: "Accueil" }, "fr");

			// ? matches against base-table `title = "Home"` (the default-locale value),
			// ? not against the French translation. Overlay still rewrites the result.
			const matchByBase = asPages(
				await crud.find("pages", { title: { equals: "Home" } }, "fr"),
			);

			expect(matchByBase).toHaveLength(1);
			expect(matchByBase[0]?.title).toBe("Accueil"); // ? overlay runs

			// ? searching for the French value finds nothing — proof we're filtering on base
			const matchByFr = asPages(
				await crud.find("pages", { title: { equals: "Accueil" } }, "fr"),
			);

			expect(matchByFr).toEqual([]);
		});

		it("delete removes both main row and translations", async () => {
			const created = asPage(
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			await crud.update("pages", created.id, { title: "Accueil" }, "fr");
			await crud.delete("pages", created.id);

			expect(await crud.findOne("pages", created.id)).toBeNull();

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
				await crud.create("pages", { title: "Accueil", slug: "home" }, "fr"),
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
				await crud.create("pages", { title: "Home", slug: "home" }),
			);

			batchCalls = 0;

			// ? mainData (slug) + translationData (title) both present → batched
			await crud.update(
				"pages",
				created.id,
				{ slug: "home-fr", title: "Accueil" },
				"fr",
			);

			expect(batchCalls).toBe(1);
		});

		it("delete with translations routes through db.batch", async () => {
			const created = asPage(
				await crud.create("pages", { title: "Home", slug: "home" }),
			);
			await crud.update("pages", created.id, { title: "Accueil" }, "fr");

			batchCalls = 0;
			await crud.delete("pages", created.id);

			expect(batchCalls).toBe(1);
			expect(await crud.findOne("pages", created.id)).toBeNull();
			expect(
				asPageTranslationRows(
					sqlite.prepare('SELECT * FROM "pages_translations"').all(),
				),
			).toHaveLength(0);
		});
	});
});
