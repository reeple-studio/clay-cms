import type { LocalizationConfig, ResolvedCollectionConfig } from "clay-cms";
import type { Where } from "clay-cms/access";
import { and, eq, ne, type SQL, sql } from "drizzle-orm";

import { isLocalized } from "./schema.js";
import type { TableMap } from "./types.js";
import { whereToDrizzle } from "./where.js";

// ? Options bags — one per op. Slug stays positional (it's the primary key
// ? every method dispatches on); everything else lives in the bag so future
// ? knobs (limit, sort, populate) slot in without growing the signature.
// ? Mirrors the proxy-side shape in runtime/api.ts.

// ? Field projection — Payload-shaped. Include mode (`{ field: true }`)
// ? returns only listed fields plus system fields. Exclude mode
// ? (`{ field: false }`) returns everything except listed. Mixing throws.
// ? Always a perf knob, never a security boundary — read-denied fields are
// ? still stripped after projection by the proxy gate.
export type Select = Record<string, boolean>;

export interface CrudFindOptions {
	where?: Where;
	locale?: string;
	showHiddenFields?: boolean;
	select?: Select;
}

export interface CrudFindOneOptions {
	id: string;
	locale?: string;
	showHiddenFields?: boolean;
	select?: Select;
}

export interface CrudCreateOptions {
	data: Record<string, unknown>;
	locale?: string;
	// ? Atomic singleton guard: only insert when the table is currently empty,
	// ? via INSERT … SELECT … WHERE NOT EXISTS. Returns null when a row already
	// ? exists. Used by the first-user setup flow to make the check+insert one
	// ? statement, closing the concurrent-setup race. SQLite serializes writes,
	// ? so the second concurrent insert sees the first's row and no-ops.
	requireEmpty?: boolean;
}

// ? "perform the write only if at least one OTHER row (id != this id), optionally
// ? matching `where`, still exists." The invariant lives in the WHERE of the write
// ? itself, so concurrent writers can't both pass a stale pre-flight count. Reuses
// ? whereToDrizzle, so it carries zero auth knowledge into this layer:
// ?   delete last user   → requireOther: {}                                  (any other row)
// ?   demote last admin  → requireOther: { where: { role: { equals: "admin" } } }
export interface RequireOther {
	where?: Where;
}

export interface CrudUpdateOptions {
	id: string;
	data: Record<string, unknown>;
	locale?: string;
	requireOther?: RequireOther;
}

export interface CrudDeleteOptions {
	id: string;
	requireOther?: RequireOther;
}

export interface CrudOperations {
	find(collection: string, opts?: CrudFindOptions): Promise<unknown[]>;
	findOne(
		collection: string,
		opts: CrudFindOneOptions,
	): Promise<unknown | null>;
	create(collection: string, opts: CrudCreateOptions): Promise<unknown>;
	update(collection: string, opts: CrudUpdateOptions): Promise<unknown>;
	// ? returns true when a row was deleted, false when a requireOther guard
	// ? blocked it (so the caller can throw the right invariant error).
	delete(collection: string, opts: CrudDeleteOptions): Promise<boolean>;
}

// ? "(SELECT COUNT(*) FROM <table> WHERE id != <id> [AND <where>]) >= 1" — a SQL
// ? fragment asserting at least one OTHER row exists. ANDed into the write's WHERE
// ? so the count is evaluated atomically with the mutation (no TOCTOU window).
function otherExistsGuard(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table is dialect-typed
	table: any,
	where: Where | undefined,
	id: string,
): SQL {
	const sub = whereToDrizzle(where, table);
	const others = sub ? sql`${ne(table.id, id)} and ${sub}` : ne(table.id, id);
	return sql`(select count(*) from ${table} where ${others}) >= 1`;
}

export function createCrud(
	db: any,
	tables: TableMap,
	collections?: ResolvedCollectionConfig[],
	localization?: LocalizationConfig,
): CrudOperations {
	const collectionMap = new Map(collections?.map((c) => [c.slug, c]));

	function getTable(collection: string) {
		const table = tables[collection];

		if (!table) {
			throw new Error(
				`[clay-cms/drizzle] Unknown collection: "${collection}".`,
			);
		}

		return table;
	}

	function getTranslationTable(collection: string) {
		return tables[`${collection}_translations`];
	}

	// ? Execute a raw returning-SQL statement across drivers without coupling to
	// ? the SQLite-only db.all(). SQLite family (D1/libsql/better-sqlite3) exposes
	// ? .all() for a RETURNING statement; pg/mysql use .execute() (rows may come
	// ? back as an array or under `.rows`).
	async function execReturning(query: SQL): Promise<Record<string, unknown>[]> {
		if (typeof db.all === "function") {
			return db.all(query);
		}
		if (typeof db.execute === "function") {
			const res = await db.execute(query);
			return Array.isArray(res) ? res : (res?.rows ?? []);
		}
		return db.run(query);
	}

	function getLocalizedFieldNames(collection: string): string[] {
		const config = collectionMap.get(collection);
		if (!config) return [];

		return Object.entries(config.fields)
			.filter(([, field]) => isLocalized(field))
			.map(([name]) => name);
	}

	function getHiddenFieldNames(collection: string): string[] {
		const config = collectionMap.get(collection);
		if (!config) return [];

		return Object.entries(config.fields)
			.filter(([, field]) => field.type === "text" && field.hidden)
			.map(([name]) => name);
	}

	function stripHiddenFields(
		row: Record<string, unknown>,
		hiddenFields: string[],
	): Record<string, unknown> {
		const result = { ...row };

		for (const field of hiddenFields) {
			delete result[field];
		}

		return result;
	}

	// ? Resolve a Select into the column allowlist + drizzle column-map shape.
	// ? Returns null when no projection is requested (full row, existing path).
	// ? `mainColumns` plugs straight into `db.select({ ... }).from(table)` for
	// ? wire-bandwidth savings on the default-locale path. `skipJoin` flips on
	// ? when no localized field is in scope — structural win, lets non-default
	// ? locale reads bypass the LEFT JOIN entirely.
	function resolveSelect(
		collection: string,
		select: Select | undefined,
	): {
		allowed: Set<string>;
		// biome-ignore lint/suspicious/noExplicitAny: drizzle column refs are dialect-typed
		mainColumns: Record<string, any>;
		skipJoin: boolean;
	} | null {
		if (!select) return null;

		const entries = Object.entries(select);
		const hasTrue = entries.some(([, v]) => v === true);
		const hasFalse = entries.some(([, v]) => v === false);

		if (hasTrue && hasFalse) {
			throw new Error(
				`[clay-cms/drizzle] select cannot mix include (true) and exclude (false) on collection "${collection}".`,
			);
		}

		const config = collectionMap.get(collection);
		const allFieldNames = config ? Object.keys(config.fields) : [];
		const localizedFields = new Set(getLocalizedFieldNames(collection));

		// ? system fields are always returned unless explicitly excluded — Payload parity
		const SYSTEM = ["id", "createdAt", "updatedAt"];

		let allowed: Set<string>;

		if (hasTrue) {
			allowed = new Set([
				...SYSTEM,
				...entries.filter(([, v]) => v === true).map(([k]) => k),
			]);
		} else {
			const excluded = new Set(
				entries.filter(([, v]) => v === false).map(([k]) => k),
			);
			allowed = new Set(
				[...SYSTEM, ...allFieldNames].filter((k) => !excluded.has(k)),
			);
		}

		const anyLocalizedSelected = [...allowed].some((k) =>
			localizedFields.has(k),
		);

		const table = getTable(collection);
		// biome-ignore lint/suspicious/noExplicitAny: drizzle column refs are dialect-typed
		const mainColumns: Record<string, any> = {};

		for (const k of allowed) {
			// ? include localized fields too: their default-locale value lives in a
			// ? real column on the MAIN table, and mainColumns is only consumed by
			// ? the default-locale select. Excluding them silently dropped localized
			// ? fields from projected default-locale reads. The non-default join path
			// ? ignores mainColumns and post-filters via pickFields, so this is safe.
			if ((table as Record<string, unknown>)[k] !== undefined) {
				mainColumns[k] = (table as Record<string, unknown>)[k];
			}
		}

		return { allowed, mainColumns, skipJoin: !anyLocalizedSelected };
	}

	function pickFields(
		row: Record<string, unknown>,
		allowed: Set<string>,
	): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const k of allowed) {
			if (k in row) out[k] = row[k];
		}
		return out;
	}

	function isNonDefaultLocale(locale?: string): boolean {
		return !!locale && !!localization && locale !== localization.defaultLocale;
	}

	function overlayTranslation(
		row: Record<string, unknown>,
		translation: Record<string, unknown> | undefined,
		localizedFields: string[],
	): Record<string, unknown> {
		if (!translation) return row;

		const result = { ...row };

		for (const field of localizedFields) {
			// ? overlay when the translation row HAS the column, even if its value is
			// ? null — a non-default locale can intentionally clear a field. The
			// ? no-translation case is handled by the early return above (drizzle
			// ? yields null for the joined table on a miss), so this never wipes the
			// ? base row for an untranslated document.
			if (field in translation) {
				result[field] = translation[field];
			}
		}

		return result;
	}

	return {
		async find(collection, opts) {
			const where = opts?.where;
			const locale = opts?.locale;
			const showHiddenFields = opts?.showHiddenFields;
			const select = opts?.select;
			const table = getTable(collection);
			const translationTable = getTranslationTable(collection);
			const localizedFields = getLocalizedFieldNames(collection);
			const hiddenFields = showHiddenFields
				? []
				: getHiddenFieldNames(collection);
			const projection = resolveSelect(collection, select);

			const condition = whereToDrizzle(where, table);

			// ? non-default locale with translations table → LEFT JOIN, unless
			// ? the projection skipped every localized field (skipJoin) — in
			// ? which case we fall through to the cheap default-locale path.
			if (
				isNonDefaultLocale(locale) &&
				translationTable &&
				localizedFields.length > 0 &&
				!projection?.skipJoin
			) {
				const baseQuery = db
					.select()
					.from(table)
					.leftJoin(
						translationTable,
						and(
							eq(translationTable._parentId, table.id),
							eq(translationTable._locale, locale),
						),
					);

				const rows = await (condition ? baseQuery.where(condition) : baseQuery);

				const translationTableName = `${collection}_translations`;
				let results = rows.map((row: Record<string, Record<string, unknown>>) =>
					overlayTranslation(
						row[collection],
						row[translationTableName],
						localizedFields,
					),
				);

				if (hiddenFields.length > 0) {
					results = results.map((row: Record<string, unknown>) =>
						stripHiddenFields(row, hiddenFields),
					);
				}

				// ? join path keeps full-row select; trim to projection on the
				// ? result side. Skips bandwidth wins but keeps the structural
				// ? wins (skipJoin) plus correctness with overlay semantics.
				if (projection) {
					results = results.map((row: Record<string, unknown>) =>
						pickFields(row, projection.allowed),
					);
				}

				return results;
			}

			// ? default locale or no localization → query main table only.
			// ? When projection is set, build a column-mapped select for the
			// ? bandwidth + serialization win on the wire.
			const baseSelect = projection
				? db.select(projection.mainColumns).from(table)
				: db.select().from(table);

			let results: Record<string, unknown>[];

			if (condition) {
				results = await baseSelect.where(condition);
			} else {
				results = await baseSelect;
			}

			if (hiddenFields.length > 0) {
				results = results.map((row) => stripHiddenFields(row, hiddenFields));
			}

			return results;
		},

		async findOne(collection, opts) {
			const { id } = opts;
			const locale = opts.locale;
			const showHiddenFields = opts.showHiddenFields;
			const select = opts.select;
			const table = getTable(collection);
			const translationTable = getTranslationTable(collection);
			const localizedFields = getLocalizedFieldNames(collection);
			const hiddenFields = showHiddenFields
				? []
				: getHiddenFieldNames(collection);
			const projection = resolveSelect(collection, select);

			// ? non-default locale with translations table → LEFT JOIN, unless
			// ? skipJoin (no localized field projected) — same rule as find().
			if (
				isNonDefaultLocale(locale) &&
				translationTable &&
				localizedFields.length > 0 &&
				!projection?.skipJoin
			) {
				const rows = await db
					.select()
					.from(table)
					.leftJoin(
						translationTable,
						and(
							eq(translationTable._parentId, table.id),
							eq(translationTable._locale, locale),
						),
					)
					.where(eq(table.id, id))
					.limit(1);

				if (rows.length === 0) return null;

				const row = rows[0] as Record<string, Record<string, unknown>>;
				const translationTableName = `${collection}_translations`;

				let result = overlayTranslation(
					row[collection],
					row[translationTableName],
					localizedFields,
				);

				if (hiddenFields.length > 0) {
					result = stripHiddenFields(result, hiddenFields);
				}

				if (projection) {
					result = pickFields(result, projection.allowed);
				}

				return result;
			}

			// ? default locale or no localization
			const baseSelect = projection
				? db.select(projection.mainColumns).from(table)
				: db.select().from(table);

			const rows = await baseSelect.where(eq(table.id, id)).limit(1);

			const result = rows[0] ?? null;

			if (result && hiddenFields.length > 0) {
				return stripHiddenFields(
					result as Record<string, unknown>,
					hiddenFields,
				);
			}

			return result;
		},

		async create(collection, opts) {
			const { data } = opts;
			const locale = opts.locale;
			const table = getTable(collection);

			// ? singleton guard (first-user setup): INSERT … SELECT … WHERE NOT
			// ? EXISTS so the "table is empty" check and the insert are one atomic
			// ? statement. Two concurrent setups with different emails can't both
			// ? pass — SQLite serializes writes, the loser's NOT EXISTS sees the
			// ? winner's committed row and inserts zero rows. Returns null then.
			if (opts.requireEmpty) {
				const now = new Date().toISOString();
				const row: Record<string, unknown> = {
					id: crypto.randomUUID(),
					createdAt: now,
					updatedAt: now,
					...data,
				};

				const cols = Object.keys(row);
				const colList = sql.join(
					cols.map((c) => sql.identifier(c)),
					sql`, `,
				);
				// ? Encode each value through its column's own driver mapper — exactly
				// ? what drizzle's `.values()` does (boolean → 0/1, json → stringified).
				// ? The raw INSERT…SELECT path bypasses `.values()`, so without this a
				// ? boolean/json field on the first-user collection would fail to bind
				// ? (SQLite can't bind a JS boolean/object) or mis-store.
				const valList = sql.join(
					cols.map((c) => {
						const value = row[c];
						if (value === undefined || value === null) return sql`null`;
						// biome-ignore lint/suspicious/noExplicitAny: dialect column ref
						const col = (table as Record<string, any>)[c];
						const encoded =
							col && typeof col.mapToDriverValue === "function"
								? col.mapToDriverValue(value)
								: value;
						return sql`${encoded}`;
					}),
					sql`, `,
				);

				const inserted = await execReturning(
					sql`insert into ${table} (${colList}) select ${valList} where not exists (select 1 from ${table}) returning *`,
				);

				const insertedRow = (inserted as Record<string, unknown>[])[0];
				if (!insertedRow) return null;

				// ? `returning *` yields raw driver values (boolean → 0/1, json →
				// ? string); decode them back to the JS-shape contract so this path
				// ? returns the same shape as a normal create.
				const decoded: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(insertedRow)) {
					// biome-ignore lint/suspicious/noExplicitAny: dialect column ref
					const col = (table as Record<string, any>)[k];
					decoded[k] =
						v !== null && col && typeof col.mapFromDriverValue === "function"
							? col.mapFromDriverValue(v)
							: v;
				}

				return decoded;
			}

			// ? non-default locale → create main row + translation row atomically.
			// ? on D1 (or any drizzle driver exposing .batch()) the two writes go
			// ? in a single batch so a failure on either rolls both back —
			// ? closing the orphan-row hole that motivated ROADMAP P0 #4. on
			// ? drivers without batch (better-sqlite3 in tests) we fall back to
			// ? sequential awaits, same as before.
			if (isNonDefaultLocale(locale)) {
				const translationTable = getTranslationTable(collection);
				const localizedFields = getLocalizedFieldNames(collection);

				if (translationTable && localizedFields.length > 0) {
					// ? split data: localized fields go to translation, rest to main row
					const mainData: Record<string, unknown> = {};
					const translationData: Record<string, unknown> = {};

					for (const [key, value] of Object.entries(data)) {
						if (localizedFields.includes(key)) {
							translationData[key] = value;
						} else {
							mainData[key] = value;
						}
					}

					const now = new Date().toISOString();
					const id = crypto.randomUUID();

					const mainRow = {
						id,
						createdAt: now,
						updatedAt: now,
						...mainData,
					};

					const mainStmt = db.insert(table).values(mainRow).returning();

					const translationStmt = db.insert(translationTable).values({
						id: crypto.randomUUID(),
						_parentId: id,
						_locale: locale,
						...translationData,
					});

					let mainResult: Record<string, unknown>[];

					if (typeof db.batch === "function") {
						// ? drizzle d1: atomic, single round-trip
						const [batched] = await db.batch([mainStmt, translationStmt]);
						mainResult = batched as Record<string, unknown>[];
					} else {
						// ? sequential fallback (better-sqlite3 / non-batching drivers)
						mainResult = await mainStmt;
						await translationStmt;
					}

					return { ...mainResult[0], ...translationData };
				}
			}

			// ? default locale or no localization
			const now = new Date().toISOString();

			const row = {
				id: crypto.randomUUID(),
				createdAt: now,
				updatedAt: now,
				...data,
			};

			const result = await db.insert(table).values(row).returning();

			return result[0];
		},

		async update(collection, opts) {
			const { id, data } = opts;
			const locale = opts.locale;
			const table = getTable(collection);

			// ? non-default locale → upsert into translation table.
			// ? EXCEPTION: a requireOther-guarded write (the auth last-admin/last-user
			// ? invariant) must run through the guarded main-table path below so the
			// ? "another admin still exists" check is ANDed atomically into the WHERE.
			// ? Its only fields are non-localized (role), so routing it here is
			// ? correct; without this, passing locale: "fr" silently bypassed the
			// ? invariant (the localized branch never consulted requireOther).
			if (isNonDefaultLocale(locale) && !opts.requireOther) {
				const translationTable = getTranslationTable(collection);
				const localizedFields = getLocalizedFieldNames(collection);

				if (translationTable && localizedFields.length > 0) {
					const mainData: Record<string, unknown> = {};
					const translationData: Record<string, unknown> = {};

					for (const [key, value] of Object.entries(data)) {
						if (localizedFields.includes(key)) {
							translationData[key] = value;
						} else {
							mainData[key] = value;
						}
					}

					// ? build the two write statements first; only then decide
					// ? whether to send them through db.batch() (atomic, D1) or
					// ? sequentially (better-sqlite3 fallback). Same atomicity
					// ? story as create() above.
					const stmts: unknown[] = [];

					if (Object.keys(mainData).length > 0) {
						stmts.push(
							db
								.update(table)
								.set({
									...mainData,
									updatedAt: new Date().toISOString(),
								})
								.where(eq(table.id, id)),
						);
					}

					if (Object.keys(translationData).length > 0) {
						stmts.push(
							db
								.insert(translationTable)
								.values({
									id: crypto.randomUUID(),
									_parentId: id,
									_locale: locale,
									...translationData,
								})
								.onConflictDoUpdate({
									target: [
										translationTable._parentId,
										translationTable._locale,
									],
									set: translationData,
								}),
						);
					}

					if (stmts.length > 0) {
						if (typeof db.batch === "function" && stmts.length > 1) {
							await db.batch(stmts);
						} else {
							for (const stmt of stmts) await stmt;
						}
					}

					// ? return the merged result
					const rows = await db
						.select()
						.from(table)
						.where(eq(table.id, id))
						.limit(1);

					return rows[0] ? { ...rows[0], ...translationData } : undefined;
				}
			}

			// ? default locale or no localization
			const set = { ...data, updatedAt: new Date().toISOString() };

			// ? guarded update (last-admin demote invariant): AND the "another
			// ? matching row still exists" check into the WHERE so it's atomic
			// ? with the write. Returns nothing when the guard fails → caller
			// ? throws the invariant error.
			const condition = opts.requireOther
				? and(
						eq(table.id, id),
						otherExistsGuard(table, opts.requireOther.where, id),
					)
				: eq(table.id, id);

			const result = await db
				.update(table)
				.set(set)
				.where(condition)
				.returning();

			return result[0];
		},

		async delete(collection, opts) {
			const { id } = opts;
			const table = getTable(collection);

			// ? guarded delete (last-user invariant): only delete when at least one
			// ? OTHER row exists, asserted atomically in the WHERE. Returns false
			// ? when blocked so the caller can raise "cannot delete the last user".
			if (opts.requireOther) {
				const deleted = await db
					.delete(table)
					.where(
						and(
							eq(table.id, id),
							otherExistsGuard(table, opts.requireOther.where, id),
						),
					)
					.returning();

				const didDelete = (deleted as unknown[]).length > 0;

				// ? clean up any translation rows only when the guarded delete
				// ? actually landed — if the guard refused, the row (and its
				// ? translations) must stay intact. Order is irrelevant (D1 doesn't
				// ? enforce FK CASCADE); a refused guard leaves nothing to orphan.
				if (didDelete) {
					const translationTable = getTranslationTable(collection);
					if (translationTable) {
						await db
							.delete(translationTable)
							.where(eq(translationTable._parentId, id));
					}
				}

				return didDelete;
			}

			// ? explicitly delete translations first (D1 doesn't enforce FK
			// ? CASCADE). batched on drivers that support it so the two deletes
			// ? are atomic — same orphan-prevention story as create/update.
			const translationTable = getTranslationTable(collection);

			if (translationTable) {
				const translationStmt = db
					.delete(translationTable)
					.where(eq(translationTable._parentId, id));

				const mainStmt = db.delete(table).where(eq(table.id, id));

				if (typeof db.batch === "function") {
					await db.batch([translationStmt, mainStmt]);
				} else {
					await translationStmt;
					await mainStmt;
				}

				return true;
			}

			await db.delete(table).where(eq(table.id, id));
			return true;
		},
	};
}
