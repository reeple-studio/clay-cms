// ? Tests for runtime/init-sql.ts — ensureTables().
// ? Pins three things:
// ?   1. every statement in config.initSqlStatements runs, in order.
// ?   2. ensureTables() is idempotent — the module-level `done` flag short-circuits.
// ?   3. the SQL generated for a real collection set round-trips into a fresh SQLite db.
// ? (3) is the fresh-DB smoke test the roadmap calls out.

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

// ? --------------------------------------------------------------
// ? (1) + (2) — ensureTables runs every stmt, once
// ? --------------------------------------------------------------

const fakeDb = {
	run: vi.fn(async () => undefined),
};

vi.mock("virtual:clay-cms/drizzle", () => ({
	default: { getDb: async () => fakeDb },
}));

vi.mock("virtual:clay-cms/config", () => ({
	default: {
		initSqlStatements: [
			`CREATE TABLE IF NOT EXISTS "posts" ("id" text PRIMARY KEY)`,
			`CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY)`,
			`CREATE TABLE IF NOT EXISTS "_sessions" ("id" text PRIMARY KEY)`,
		],
	},
}));

const { default: ensureTables } = await import("./init-sql.js");

describe("ensureTables — statement execution", () => {
	it("runs every statement from config.initSqlStatements on first call", async () => {
		await ensureTables();

		expect(fakeDb.run).toHaveBeenCalledTimes(3);
	});

	it("is idempotent — repeat calls do NOT re-run statements", async () => {
		const before = fakeDb.run.mock.calls.length;

		await ensureTables();
		await ensureTables();
		await ensureTables();

		expect(fakeDb.run.mock.calls.length).toBe(before);
	});
});

// ? --------------------------------------------------------------
// ? (3) — fresh-DB smoke test: real collections → real SQL → real sqlite
// ? --------------------------------------------------------------

describe("generated init SQL — fresh-DB smoke test", () => {
	it("creates every collection table + _sessions against an empty sqlite db", async () => {
		const { resolveCollections } = await import("../collections/resolve.js");

		const { buildSchema, generateCreateStatements } = await import(
			"@clay-cms/drizzle"
		);

		const sqlite = await import("drizzle-orm/sqlite-core");

		const { getTableConfig, integer, sqliteTable, text, unique } = sqlite;

		const timestamp = (name: string) => text(name);
		const boolean = (name: string) => integer(name, { mode: "boolean" });
		const json = (name: string) => text(name, { mode: "json" });

		const collections = resolveCollections([
			{
				slug: "posts",
				fields: { title: { type: "text", required: true } },
			},
			{
				slug: "users",
				auth: true,
				fields: {
					name: { type: "text", required: true },
					role: {
						type: "select",
						options: ["admin", "customer"],
						required: true,
					},
				},
			},
		]);

		const tables = buildSchema(collections, {
			tableFactory: sqliteTable,
			columns: { text, integer, boolean, timestamp, json },
			unique,
			getTableConfig,
		});

		const stmts = generateCreateStatements(tables, getTableConfig);

		const db = new Database(":memory:");

		for (const stmt of stmts) db.prepare(stmt).run();

		const rows = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all() as { name: string }[];

		const names = rows.map((r) => r.name);

		expect(names).toContain("posts");
		expect(names).toContain("users");
		expect(names).toContain("_sessions");

		// ? spot-check the auth collection has its required columns — a lost NOT NULL
		// ? or missing column would be silently swallowed by CRUD round-trip tests.
		const userCols = db.prepare("PRAGMA table_info('users')").all() as {
			name: string;
			notnull: number;
		}[];

		// ? typed lookup helper — avoids `| undefined` indexing noise in assertions
		const col = (n: string) => {
			const found = userCols.find((c) => c.name === n);

			if (!found) throw new Error(`expected column "${n}" on users table`);

			return found;
		};

		expect(col("id")).toBeDefined();
		expect(col("email")).toBeDefined();
		expect(col("hashedPassword")).toBeDefined();

		// ? `name` is a user-defined field with `required: true` — must map to NOT NULL (Payload parity).
		expect(col("name").notnull).toBe(1);

		// ? `role` is also required → NOT NULL
		expect(col("role").notnull).toBe(1);

		// ? _sessions must have the columns createSession() inserts
		const sessionCols = db.prepare("PRAGMA table_info('_sessions')").all() as {
			name: string;
		}[];

		const sessionByName = new Set(sessionCols.map((c) => c.name));

		expect(sessionByName.has("id")).toBe(true);
		expect(sessionByName.has("token")).toBe(true);
		expect(sessionByName.has("userId")).toBe(true);
		expect(sessionByName.has("expiresAt")).toBe(true);

		db.close();
	});
});
