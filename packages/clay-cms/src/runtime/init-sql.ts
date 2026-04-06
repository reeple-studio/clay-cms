// @ts-nocheck — shipped as source, type-checked in the consumer's Vite/Astro pipeline.
// ? runs CREATE TABLE IF NOT EXISTS for all collection tables on first request.

import config from "virtual:clay-cms/config";
import drizzle from "virtual:clay-cms/drizzle";
import { sql } from "drizzle-orm";

let done = false;

export default async function ensureTables(): Promise<void> {
	if (done) return;

	const db = await drizzle.getDb();

	for (const stmt of config.initSqlStatements) {
		await db.run(sql.raw(stmt));
	}

	done = true;
}
