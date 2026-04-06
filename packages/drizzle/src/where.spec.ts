import Database from "better-sqlite3";
import type { Where } from "clay-cms/access";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { whereToDrizzle } from "./where.js";

// ? ── Test fixture: a real drizzle table backed by in-memory SQLite ───────

const orders = sqliteTable("orders", {
	id: text("id").primaryKey(),
	customer: text("customer").notNull(),
	status: text("status").notNull(),
	total: integer("total").notNull(),
	notes: text("notes"),
	// ? hasMany / array field stored as JSON text — exercises the `contains` op
	tags: text("tags"),
});

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite
		.prepare(
			`CREATE TABLE "orders" (
				"id" TEXT PRIMARY KEY,
				"customer" TEXT NOT NULL,
				"status" TEXT NOT NULL,
				"total" INTEGER NOT NULL,
				"notes" TEXT,
				"tags" TEXT
			)`,
		)
		.run();

	db = drizzle(sqlite);

	// ? seed
	db.insert(orders)
		.values([
			{
				id: "o1",
				customer: "u1",
				status: "paid",
				total: 100,
				notes: "Urgent",
				tags: JSON.stringify(["new", "priority"]),
			},
			{
				id: "o2",
				customer: "u1",
				status: "pending",
				total: 50,
				notes: null,
				tags: JSON.stringify(["new"]),
			},
			{
				id: "o3",
				customer: "u2",
				status: "paid",
				total: 200,
				notes: "VIP",
				tags: JSON.stringify(["priority"]),
			},
			{
				id: "o4",
				customer: "u2",
				status: "shipped",
				total: 75,
				notes: null,
				tags: null,
			},
		])
		.run();
});

afterEach(() => {
	sqlite.close();
});

function find(where: Where | undefined) {
	const condition = whereToDrizzle(where, orders);
	return condition
		? db.select().from(orders).where(condition).all()
		: db.select().from(orders).all();
}

describe("whereToDrizzle — north star (storefront 'my orders')", () => {
	it("filters orders to those owned by the user", () => {
		const result = find({ customer: { equals: "u1" } });
		expect(result.map((r) => r.id).sort()).toEqual(["o1", "o2"]);
	});
});

describe("whereToDrizzle — operators", () => {
	it("equals / not_equals", () => {
		expect(
			find({ status: { equals: "paid" } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3"]);

		expect(
			find({ status: { not_equals: "paid" } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o2", "o4"]);
	});

	it("in / not_in", () => {
		expect(
			find({ status: { in: ["paid", "shipped"] } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3", "o4"]);

		expect(
			find({ status: { not_in: ["paid"] } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o2", "o4"]);
	});

	it("exists", () => {
		expect(
			find({ notes: { exists: true } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3"]);

		expect(
			find({ notes: { exists: false } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o2", "o4"]);
	});

	it("greater_than / less_than (and _equal)", () => {
		expect(
			find({ total: { greater_than: 75 } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3"]);

		expect(
			find({ total: { greater_than_equal: 75 } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3", "o4"]);

		expect(
			find({ total: { less_than: 100 } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o2", "o4"]);

		expect(
			find({ total: { less_than_equal: 100 } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o2", "o4"]);
	});

	it("like — case-insensitive substring (Payload semantics)", () => {
		expect(find({ notes: { like: "urgent" } }).map((r) => r.id)).toEqual([
			"o1",
		]);

		expect(find({ notes: { like: "URGENT" } }).map((r) => r.id)).toEqual([
			"o1",
		]);

		expect(find({ notes: { like: "vip" } }).map((r) => r.id)).toEqual(["o3"]);
	});
});

describe("whereToDrizzle — and / or", () => {
	it("and: all sub-clauses must match", () => {
		const w: Where = {
			and: [{ customer: { equals: "u1" } }, { status: { equals: "paid" } }],
		};

		expect(find(w).map((r) => r.id)).toEqual(["o1"]);
	});

	it("or: any sub-clause may match", () => {
		const w: Where = {
			or: [{ customer: { equals: "u2" } }, { status: { equals: "pending" } }],
		};

		expect(
			find(w)
				.map((r) => r.id)
				.sort(),
		).toEqual(["o2", "o3", "o4"]);
	});

	it("nested or — admin OR own docs (the helper combinator pattern)", () => {
		// ? pretend the user is u1 and not admin → should resolve to just their docs
		const w: Where = {
			or: [
				{ customer: { equals: "__never__" } }, // ? admin branch (no match)
				{ customer: { equals: "u1" } }, // ? own-docs branch
			],
		};

		expect(
			find(w)
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o2"]);
	});

	it("multiple top-level fields are AND-ed implicitly", () => {
		expect(
			find({
				customer: { equals: "u2" },
				status: { equals: "paid" },
			}).map((r) => r.id),
		).toEqual(["o3"]);
	});
});

describe("whereToDrizzle — edge cases", () => {
	it("undefined where returns no condition (matches all)", () => {
		expect(find(undefined).length).toBe(4);
	});

	it("empty where returns no condition (matches all)", () => {
		expect(find({}).length).toBe(4);
	});

	it("throws on unknown column", () => {
		expect(() => whereToDrizzle({ bogus: { equals: "x" } }, orders)).toThrow(
			/unknown column/,
		);
	});

	it("throws on unknown operator", () => {
		expect(() =>
			whereToDrizzle({ status: { bogus_op: "x" } } as unknown as Where, orders),
		).toThrow(/unknown operator/);
	});

	it("blocks the translation-table system columns _parentId / _locale", () => {
		expect(() =>
			whereToDrizzle(
				{ _parentId: { equals: "p1" } } as unknown as Where,
				orders,
			),
		).toThrow(/_parentId.*cannot be used in a where clause/);

		expect(() =>
			whereToDrizzle({ _locale: { equals: "fr" } } as unknown as Where, orders),
		).toThrow(/_locale.*cannot be used in a where clause/);
	});
});

describe("whereToDrizzle — operator gaps", () => {
	it("contains: matches array fields stored as JSON text", () => {
		expect(
			find({ tags: { contains: "priority" } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3"]);

		expect(
			find({ tags: { contains: "new" } })
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o2"]);
	});

	it("contains: returns empty when no row matches", () => {
		expect(find({ tags: { contains: "nonexistent" } })).toEqual([]);
	});

	it("in: empty array yields no rows (drizzle inArray semantics)", () => {
		expect(find({ status: { in: [] } })).toEqual([]);
	});

	it("not_in: empty array yields all rows", () => {
		expect(find({ status: { not_in: [] } })).toHaveLength(4);
	});

	it("like: handles SQL wildcards as literals (not interpreted)", () => {
		// ? Payload semantics treat `%` and `_` as literal substrings, never wildcards.
		// ? None of the seeded notes contain a literal `%` or `_`, so a search for either
		// ? must match nothing. The pre-escape impl pipes `%` straight into LIKE and
		// ? matches every non-null row — this assertion is the regression pin.
		expect(find({ notes: { like: "%" } })).toEqual([]);
		expect(find({ notes: { like: "_" } })).toEqual([]);
	});

	it("like: matches a literal `%` inserted into the data", () => {
		// ? Positive direction: prove the escape clause still allows a query to find
		// ? rows that genuinely contain `%`. Insert a row, search for its literal,
		// ? expect exactly that row back.
		db.insert(orders)
			.values({
				id: "o5",
				customer: "u3",
				status: "paid",
				total: 42,
				notes: "50% off",
				tags: null,
			})
			.run();

		expect(find({ notes: { like: "50%" } }).map((r) => r.id)).toEqual(["o5"]);
	});

	it("like: backslash in the query value is treated as a literal", () => {
		// ? The escape char is `\` itself, so a raw backslash in user input must be
		// ? re-escaped before hitting the driver. Otherwise `\x` inside LIKE is a
		// ? half-formed escape sequence and the DB behavior is undefined.
		db.insert(orders)
			.values({
				id: "o6",
				customer: "u3",
				status: "paid",
				total: 10,
				notes: "path\\to\\file",
				tags: null,
			})
			.run();

		expect(find({ notes: { like: "path\\to" } }).map((r) => r.id)).toEqual([
			"o6",
		]);
	});

	it("like: case-insensitivity holds for mixed-case search", () => {
		expect(find({ notes: { like: "uRgEnT" } }).map((r) => r.id)).toEqual([
			"o1",
		]);
	});
});

describe("whereToDrizzle — deeply nested combinators", () => {
	it("and([or([...]), or([...])]) — cross-product filter", () => {
		const w: Where = {
			and: [
				{
					or: [{ customer: { equals: "u1" } }, { customer: { equals: "u2" } }],
				},
				{
					or: [
						{ status: { equals: "paid" } },
						{ status: { equals: "shipped" } },
					],
				},
			],
		};

		expect(
			find(w)
				.map((r) => r.id)
				.sort(),
		).toEqual(["o1", "o3", "o4"]);
	});

	it("or with empty sub-arrays drops out cleanly", () => {
		// ? empty `and: []` / `or: []` should produce no clause and not crash
		expect(find({ and: [] }).length).toBe(4);
		expect(find({ or: [] }).length).toBe(4);
	});

	it("mixed top-level field + and: AND-ed together", () => {
		const w: Where = {
			customer: { equals: "u1" },
			and: [{ total: { greater_than: 75 } }],
		};

		expect(find(w).map((r) => r.id)).toEqual(["o1"]);
	});
});
