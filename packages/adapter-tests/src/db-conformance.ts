// ? Shared DB-adapter conformance suite. Any adapter that exposes the standard
// ? DrizzleAccessor (getDb + schemaConfig) and generateInitSQL can be dropped in
// ? and proven interchangeable against a LIVE instance — the same battery of
// ? assertions runs for every driver. This is the gate the ROADMAP requires
// ? before a new DB adapter merges. Storage conformance is a separate suite
// ? (deferred until upload/serve routes exist).
//
// ? Usage (in an adapter's *.spec.ts):
// ?   runDbConformance({ name: "libsql", makeAdapter: () => libsql({ url: ":memory:" }), supportsTransactions: true })

import {
	buildSchema,
	type CrudOperations,
	createCrud,
} from "@clay-cms/drizzle";
import type {
	DatabaseAdapterResult,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "clay-cms";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

export interface DbConformanceHarness {
	name: string;
	// ? returns a FRESH adapter over an empty database — called per test for isolation
	// ? (e.g. a new `:memory:` libSQL client each time).
	makeAdapter: () => DatabaseAdapterResult;
	// ? does the driver support async interactive transactions with rollback?
	// ? libSQL/postgres: yes. D1: no primitive. better-sqlite3: sync-only → treat as no.
	// ? Gates the transaction section ("transaction semantics — where supported").
	supportsTransactions?: boolean;
}

const allow = () => true;
// biome-ignore lint/suspicious/noExplicitAny: resolved access shape is a fn map
const openAccess: any = {
	read: allow,
	create: allow,
	update: allow,
	delete: allow,
	admin: allow,
};

// ? content collection — every scalar field type + a hidden field
const postsCollection: ResolvedCollectionConfig = {
	slug: "posts",
	access: openAccess,
	fields: {
		id: { type: "text", required: true },
		createdAt: { type: "text", required: true },
		updatedAt: { type: "text", required: true },
		title: { type: "text" },
		views: { type: "number" },
		published: { type: "boolean" },
		status: { type: "select", options: ["draft", "published"] },
	},
};

// ? auth collection — drives _sessions/_rate_limits generation + guarded writes
const usersCollection: ResolvedCollectionConfig = {
	slug: "users",
	auth: true,
	access: openAccess,
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

// ? localized collection — overlay + cascade delete
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

const collections = [postsCollection, usersCollection, pagesCollection];
const localization: LocalizationConfig = {
	locales: ["en", "fr"],
	defaultLocale: "en",
};

// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-typed
type Db = any;
type Row = Record<string, unknown>;

function asRows(v: unknown): Row[] {
	if (!Array.isArray(v)) throw new Error("expected an array of rows");
	return v as Row[];
}
function asRow(v: unknown): Row {
	if (v === null || typeof v !== "object") throw new Error("expected a row");
	return v as Row;
}

export function runDbConformance(harness: DbConformanceHarness): void {
	describe(`DB adapter conformance — ${harness.name}`, () => {
		let db: Db;
		let crud: CrudOperations;

		beforeEach(async () => {
			const adapter = harness.makeAdapter();
			if (!adapter.drizzle || !adapter.generateInitSQL) {
				throw new Error(
					`[adapter-tests] "${harness.name}" must expose drizzle + generateInitSQL`,
				);
			}

			db = await adapter.drizzle.getDb();
			const tables = buildSchema(
				collections,
				adapter.drizzle.schemaConfig,
				localization,
			);

			// ? provision the live DB exactly as the runtime does — via the adapter's
			// ? own generateInitSQL, so we conform the real DDL, not a test shortcut.
			for (const stmt of adapter.generateInitSQL(collections, localization)) {
				await db.run(sql.raw(stmt));
			}

			crud = createCrud(db, tables, collections, localization);
		});

		describe("CRUD", () => {
			it("create returns id + timestamps and round-trips via findOne", async () => {
				const created = asRow(
					await crud.create("posts", {
						data: {
							title: "Hello",
							views: 3,
							published: true,
							status: "draft",
						},
					}),
				);

				expect(typeof created.id).toBe("string");
				expect(created.createdAt).toBeDefined();
				expect(created.updatedAt).toBeDefined();
				// ? JS-shape contract: integer→number, boolean→boolean
				expect(created.views).toBe(3);
				expect(created.published).toBe(true);

				const found = asRow(
					await crud.findOne("posts", { id: created.id as string }),
				);
				expect(found.title).toBe("Hello");
				expect(found.published).toBe(true);
			});

			it("find returns all rows; findOne returns null for a missing id", async () => {
				await crud.create("posts", { data: { title: "A" } });
				await crud.create("posts", { data: { title: "B" } });

				expect(asRows(await crud.find("posts"))).toHaveLength(2);
				expect(await crud.findOne("posts", { id: "nope" })).toBeNull();
			});

			it("update mutates and delete removes", async () => {
				const created = asRow(
					await crud.create("posts", { data: { title: "X" } }),
				);
				const id = created.id as string;

				const updated = asRow(
					await crud.update("posts", { id, data: { title: "X2" } }),
				);
				expect(updated.title).toBe("X2");

				expect(await crud.delete("posts", { id })).toBe(true);
				expect(await crud.findOne("posts", { id })).toBeNull();
			});
		});

		describe("Where operators", () => {
			beforeEach(async () => {
				await crud.create("posts", {
					data: { title: "Alpha", views: 10, status: "draft" },
				});
				await crud.create("posts", {
					data: { title: "Beta", views: 20, status: "published" },
				});
				await crud.create("posts", {
					data: { title: "Gamma", views: 30, status: "published" },
				});
			});

			it("equals", async () => {
				const r = asRows(
					await crud.find("posts", {
						where: { status: { equals: "published" } },
					}),
				);
				expect(r).toHaveLength(2);
			});

			it("in", async () => {
				const r = asRows(
					await crud.find("posts", {
						where: { title: { in: ["Alpha", "Gamma"] } },
					}),
				);
				expect(r.map((x) => x.title).sort()).toEqual(["Alpha", "Gamma"]);
			});

			it("greater_than", async () => {
				const r = asRows(
					await crud.find("posts", { where: { views: { greater_than: 15 } } }),
				);
				expect(r).toHaveLength(2);
			});

			it("like is a case-insensitive substring (literal %/_)", async () => {
				const r = asRows(
					await crud.find("posts", { where: { title: { like: "ph" } } }),
				);
				expect(r.map((x) => x.title)).toEqual(["Alpha"]);

				// ? a wildcard-only query must NOT widen to all rows
				const wild = asRows(
					await crud.find("posts", { where: { title: { like: "%" } } }),
				);
				expect(wild).toHaveLength(0);
			});

			// ? The two documented cross-evaluator invariants, live per adapter:
			// ? not_equals / not_in are NULL-inclusive (SQL emits `or(ne, isNull)`);
			// ? a non-array in/not_in operand fails CLOSED. Regressing either one
			// ? re-opens the table-leak / authz-divergence the parity tests guard.

			it("not_equals is NULL-inclusive", async () => {
				// ? the 3 seeded rows have published = NULL; add one with published = true
				await crud.create("posts", {
					data: { title: "Delta", views: 40, published: true },
				});

				const r = asRows(
					await crud.find("posts", {
						where: { published: { not_equals: true } },
					}),
				);
				// ? bare `published != 1` would drop the NULL rows — NULL-inclusive keeps them
				expect(r.map((x) => x.title).sort()).toEqual([
					"Alpha",
					"Beta",
					"Gamma",
				]);
			});

			it("not_in is NULL-inclusive", async () => {
				await crud.create("posts", { data: { title: "NoViews" } }); // views = NULL

				const r = asRows(
					await crud.find("posts", {
						where: { views: { not_in: [10, 20] } },
					}),
				);
				// ? Gamma(30) matches, NoViews(NULL) is included
				expect(r.map((x) => x.title).sort()).toEqual(["Gamma", "NoViews"]);
			});

			it("non-array in fails CLOSED (returns nothing, never the whole table)", async () => {
				const r = asRows(
					await crud.find("posts", {
						// ? malformed operand — must match nothing, not leak every row
						where: { title: { in: "Alpha" as unknown as string[] } },
					}),
				);
				expect(r).toHaveLength(0);
			});

			it("exists true / false", async () => {
				await crud.create("posts", { data: { title: "NoViews" } }); // views = NULL

				const withViews = asRows(
					await crud.find("posts", { where: { views: { exists: true } } }),
				);
				expect(withViews.map((x) => x.title).sort()).toEqual([
					"Alpha",
					"Beta",
					"Gamma",
				]);

				const without = asRows(
					await crud.find("posts", { where: { views: { exists: false } } }),
				);
				expect(without.map((x) => x.title)).toEqual(["NoViews"]);
			});

			it("less_than / greater_than_equal / less_than_equal", async () => {
				expect(
					asRows(
						await crud.find("posts", { where: { views: { less_than: 20 } } }),
					).map((x) => x.title),
				).toEqual(["Alpha"]);

				expect(
					asRows(
						await crud.find("posts", {
							where: { views: { greater_than_equal: 20 } },
						}),
					)
						.map((x) => x.title)
						.sort(),
				).toEqual(["Beta", "Gamma"]);

				expect(
					asRows(
						await crud.find("posts", {
							where: { views: { less_than_equal: 20 } },
						}),
					)
						.map((x) => x.title)
						.sort(),
				).toEqual(["Alpha", "Beta"]);
			});

			it("and / or combinators", async () => {
				const andR = asRows(
					await crud.find("posts", {
						where: {
							and: [
								{ status: { equals: "published" } },
								{ views: { greater_than: 25 } },
							],
						},
					}),
				);
				expect(andR.map((x) => x.title)).toEqual(["Gamma"]);

				const orR = asRows(
					await crud.find("posts", {
						where: {
							or: [
								{ title: { equals: "Alpha" } },
								{ views: { greater_than: 25 } },
							],
						},
					}),
				);
				expect(orR.map((x) => x.title).sort()).toEqual(["Alpha", "Gamma"]);
			});
		});

		describe("select projection", () => {
			it("include mode returns listed fields + system fields only", async () => {
				await crud.create("posts", { data: { title: "P", views: 9 } });
				const [row] = asRows(
					await crud.find("posts", { select: { title: true } }),
				);
				expect(row?.title).toBe("P");
				expect(row?.id).toBeDefined();
				expect(row).not.toHaveProperty("views");
			});
		});

		describe("system tables", () => {
			it("_sessions and _rate_limits exist and are queryable (empty) for auth collections", async () => {
				// ? a missing table throws; a present one returns a real count row.
				// ? Freshly provisioned → both empty. Asserts existence AND shape.
				const sessions = asRows(
					await db.all(sql.raw("SELECT count(*) AS c FROM _sessions")),
				);
				const rateLimits = asRows(
					await db.all(sql.raw("SELECT count(*) AS c FROM _rate_limits")),
				);
				expect(Number(sessions[0]?.c)).toBe(0);
				expect(Number(rateLimits[0]?.c)).toBe(0);
			});

			it("hidden fields are stripped by default, returned with showHiddenFields", async () => {
				await crud.create("users", {
					data: { email: "a@x.com", hashedPassword: "h", role: "admin" },
				});
				const [masked] = asRows(await crud.find("users"));
				expect(masked).not.toHaveProperty("hashedPassword");

				const [full] = asRows(
					await crud.find("users", { showHiddenFields: true }),
				);
				expect(full?.hashedPassword).toBe("h");
			});
		});

		describe("localization", () => {
			it("overlays non-default locale and preserves non-localized fields", async () => {
				const page = asRow(
					await crud.create("pages", { data: { title: "Home", slug: "home" } }),
				);
				const id = page.id as string;

				await crud.update("pages", {
					id,
					data: { title: "Accueil" },
					locale: "fr",
				});

				const [fr] = asRows(await crud.find("pages", { locale: "fr" }));
				expect(fr?.title).toBe("Accueil");
				expect(fr?.slug).toBe("home"); // ? non-localized field comes from the main row

				const [en] = asRows(await crud.find("pages"));
				expect(en?.title).toBe("Home");
			});

			it("delete cascades to translation rows", async () => {
				const page = asRow(
					await crud.create("pages", { data: { title: "T", slug: "t" } }),
				);
				const id = page.id as string;
				await crud.update("pages", { id, data: { title: "Tr" }, locale: "fr" });

				await crud.delete("pages", { id });

				expect(asRows(await crud.find("pages", { locale: "fr" }))).toHaveLength(
					0,
				);
			});
		});

		describe("init-SQL idempotency", () => {
			it("re-running the CREATE statements is a no-op that preserves data", async () => {
				const created = asRow(
					await crud.create("posts", { data: { title: "survivor" } }),
				);

				// ? re-run the exact provisioning DDL. CREATE TABLE IF NOT EXISTS must
				// ? neither throw nor drop/recreate the table (which would wipe the row).
				const adapter = harness.makeAdapter();
				if (!adapter.generateInitSQL) throw new Error("no generateInitSQL");
				for (const stmt of adapter.generateInitSQL(collections, localization)) {
					await db.run(sql.raw(stmt));
				}

				const still = await crud.findOne("posts", { id: created.id as string });
				expect(asRow(still).title).toBe("survivor");
			});
		});

		describe("guarded writes (race invariants)", () => {
			it("create requireEmpty inserts once, returns null thereafter", async () => {
				const first = await crud.create("users", {
					data: { email: "first@x.com", hashedPassword: "h", role: "admin" },
					requireEmpty: true,
				});
				expect(first).not.toBeNull();

				const second = await crud.create("users", {
					data: { email: "second@x.com", hashedPassword: "h", role: "admin" },
					requireEmpty: true,
				});
				expect(second).toBeNull();
				expect(asRows(await crud.find("users"))).toHaveLength(1);
			});

			it("delete requireOther refuses the last row", async () => {
				const a = asRow(
					await crud.create("users", {
						data: { email: "a@x.com", hashedPassword: "h" },
					}),
				);
				await crud.create("users", {
					data: { email: "b@x.com", hashedPassword: "h" },
				});

				expect(
					await crud.delete("users", { id: a.id as string, requireOther: {} }),
				).toBe(true);

				const [last] = asRows(await crud.find("users"));
				expect(
					await crud.delete("users", {
						id: last?.id as string,
						requireOther: {},
					}),
				).toBe(false);
				expect(asRows(await crud.find("users"))).toHaveLength(1);
			});

			it("update requireOther refuses to demote the last admin", async () => {
				const a = asRow(
					await crud.create("users", {
						data: { email: "a@x.com", hashedPassword: "h", role: "admin" },
					}),
				);
				await crud.create("users", {
					data: { email: "b@x.com", hashedPassword: "h", role: "customer" },
				});

				const result = await crud.update("users", {
					id: a.id as string,
					data: { role: "customer" },
					requireOther: { where: { role: { equals: "admin" } } },
				});
				expect(result).toBeUndefined();
			});
		});

		// ? Driver capability, not rollback re-testing. `cms.transaction(fn)`
		// ? feature-detects `db.transaction`, and its rollback semantics (incl.
		// ? after-hook rollback) are pinned in clay-cms api.spec.ts. Here we assert
		// ? the adapter's db actually exposes the primitive Clay feature-detects on
		// ? — the honest conformance bar (raw interactive-tx rollback can't be
		// ? exercised on in-memory libSQL, whose transactions use a separate
		// ? connection). Adapters that don't support it get an explicit it.skip so
		// ? the report shows "skipped", never a hollow green pass.
		describe("driver capabilities", () => {
			if (harness.supportsTransactions) {
				it("exposes db.transaction, so cms.transaction(fn) works", () => {
					expect(typeof db.transaction).toBe("function");
				});
			} else {
				it.skip("interactive transactions — driver has no BEGIN/COMMIT primitive (cms.transaction throws by design)", () => {});
			}
		});
	});
}
