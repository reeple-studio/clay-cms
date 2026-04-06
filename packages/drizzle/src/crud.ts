import type { LocalizationConfig, ResolvedCollectionConfig } from "clay-cms";
import type { Where } from "clay-cms/access";
import { and, eq } from "drizzle-orm";

import { isLocalized } from "./schema.js";
import type { TableMap } from "./types.js";
import { whereToDrizzle } from "./where.js";

export interface CrudOperations {
	find(
		collection: string,
		where?: Where,
		locale?: string,
		showHiddenFields?: boolean,
	): Promise<unknown[]>;
	findOne(
		collection: string,
		id: string,
		locale?: string,
		showHiddenFields?: boolean,
	): Promise<unknown | null>;
	create(
		collection: string,
		data: Record<string, unknown>,
		locale?: string,
	): Promise<unknown>;
	update(
		collection: string,
		id: string,
		data: Record<string, unknown>,
		locale?: string,
	): Promise<unknown>;
	delete(collection: string, id: string): Promise<void>;
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
			if (translation[field] != null) {
				result[field] = translation[field];
			}
		}

		return result;
	}

	return {
		async find(collection, where, locale, showHiddenFields) {
			const table = getTable(collection);
			const translationTable = getTranslationTable(collection);
			const localizedFields = getLocalizedFieldNames(collection);
			const hiddenFields = showHiddenFields
				? []
				: getHiddenFieldNames(collection);

			const condition = whereToDrizzle(where, table);

			// ? non-default locale with translations table → LEFT JOIN
			if (
				isNonDefaultLocale(locale) &&
				translationTable &&
				localizedFields.length > 0
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

				return results;
			}

			// ? default locale or no localization → query main table only
			let results: Record<string, unknown>[];

			if (condition) {
				results = await db.select().from(table).where(condition);
			} else {
				results = await db.select().from(table);
			}

			if (hiddenFields.length > 0) {
				results = results.map((row) => stripHiddenFields(row, hiddenFields));
			}

			return results;
		},

		async findOne(collection, id, locale, showHiddenFields) {
			const table = getTable(collection);
			const translationTable = getTranslationTable(collection);
			const localizedFields = getLocalizedFieldNames(collection);
			const hiddenFields = showHiddenFields
				? []
				: getHiddenFieldNames(collection);

			// ? non-default locale with translations table → LEFT JOIN
			if (
				isNonDefaultLocale(locale) &&
				translationTable &&
				localizedFields.length > 0
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

				return result;
			}

			// ? default locale or no localization
			const rows = await db
				.select()
				.from(table)
				.where(eq(table.id, id))
				.limit(1);

			const result = rows[0] ?? null;

			if (result && hiddenFields.length > 0) {
				return stripHiddenFields(
					result as Record<string, unknown>,
					hiddenFields,
				);
			}

			return result;
		},

		async create(collection, data, locale) {
			const table = getTable(collection);

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

		async update(collection, id, data, locale) {
			const table = getTable(collection);

			// ? non-default locale → upsert into translation table
			if (isNonDefaultLocale(locale)) {
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
			const result = await db
				.update(table)
				.set({ ...data, updatedAt: new Date().toISOString() })
				.where(eq(table.id, id))
				.returning();

			return result[0];
		},

		async delete(collection, id) {
			const table = getTable(collection);

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

				return;
			}

			await db.delete(table).where(eq(table.id, id));
		},
	};
}
