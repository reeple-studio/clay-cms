// @ts-nocheck — shipped as source, type-checked in the consumer's Vite/Astro pipeline.
// ? runs CREATE TABLE IF NOT EXISTS for all collection tables on first request.

import { sql } from "drizzle-orm";

import config from "virtual:clay-cms/config";
import drizzle from "virtual:clay-cms/drizzle";

let done = false;
let inFlight: Promise<void> | null = null;

export default async function ensureTables(): Promise<void> {
	if (done) return;

	// ? single-flight: two concurrent cold-start requests share one DDL run
	// ? instead of both racing the (idempotent) CREATE TABLE IF NOT EXISTS.
	// ? On failure the promise is cleared so the next request retries.
	if (!inFlight) {
		inFlight = (async () => {
			const db = await drizzle.getDb();

			for (const stmt of config.initSqlStatements) {
				await db.run(sql.raw(stmt));
			}

			done = true;
		})().finally(() => {
			inFlight = null;
		});
	}

	return inFlight;
}
