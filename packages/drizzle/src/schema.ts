import type {
	FieldConfig,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "clay-cms";

import type { SchemaBuilderConfig, TableMap } from "./types.js";

export function isLocalized(field: FieldConfig): boolean {
	return (
		(field.type === "text" || field.type === "select") &&
		field.localized === true
	);
}

export function buildSchema(
	collections: ResolvedCollectionConfig[],
	config: SchemaBuilderConfig,
	localization?: LocalizationConfig,
): TableMap {
	const tables: TableMap = {};

	for (const collection of collections) {
		const columns: Record<string, any> = {};

		for (const [name, field] of Object.entries(collection.fields)) {
			columns[name] = mapFieldToColumn(name, field, collection, config);
		}

		tables[collection.slug] = config.tableFactory(collection.slug, columns);

		// ? build _translations sibling table for localized fields
		if (localization && collection.hasLocalizedFields && config.unique) {
			// ? capture the narrowed builder so the extraConfig closure below doesn't
			// ? need a non-null assertion on config.unique (which the project bans).
			const uniqueBuilder = config.unique;

			const translationColumns: Record<string, any> = {
				id: config.columns.text("id").primaryKey(),
				_parentId: config.columns.text("_parentId").notNull(),
				_locale: config.columns.text("_locale").notNull(),
			};

			for (const [name, field] of Object.entries(collection.fields)) {
				if (isLocalized(field)) {
					translationColumns[name] = mapFieldToColumn(
						name,
						field,
						collection,
						config,
					);
				}
			}

			const tableName = `${collection.slug}_translations`;

			tables[tableName] = config.tableFactory(
				tableName,
				translationColumns,
				(table: any) => ({
					parentLocaleUnique: uniqueBuilder().on(
						table._parentId,
						table._locale,
					),
				}),
			);
		}
	}

	// ? system tables for auth collections: _sessions (login state) and
	// ? _rate_limits (login/setup throttle). Both ride the auto-init-SQL flow.
	const hasAuth = collections.some((c) => c.auth);
	if (hasAuth) {
		tables._sessions = config.tableFactory("_sessions", {
			id: config.columns.text("id").primaryKey(),
			token: config.columns.text("token").notNull().unique(),
			userId: config.columns.text("userId").notNull(),
			expiresAt: config.columns.timestamp("expiresAt").notNull(),
			createdAt: config.columns.timestamp("createdAt").notNull(),
		});

		tables._rate_limits = config.tableFactory("_rate_limits", {
			key: config.columns.text("key").primaryKey(),
			count: config.columns.integer("count").notNull(),
			windowStart: config.columns.timestamp("windowStart").notNull(),
		});
	}

	return tables;
}

function mapFieldToColumn(
	name: string,
	field: import("clay-cms").FieldConfig,
	collection: ResolvedCollectionConfig,
	config: SchemaBuilderConfig,
): any {
	const { columns } = config;

	// ? system fields get special treatment
	if (name === "id") {
		return columns.text("id").primaryKey();
	}

	if (name === "createdAt" || name === "updatedAt") {
		return columns.timestamp(name).notNull();
	}

	// ? upload fields
	if (collection.upload) {
		if (name === "filename" || name === "mimeType" || name === "url") {
			return columns.text(name).notNull();
		}

		if (name === "filesize") {
			return columns.integer("filesize").notNull();
		}

		if (name === "width" || name === "height") {
			return columns.integer(name);
		}
	}

	// ? auth fields
	if (collection.auth) {
		if (name === "email") {
			return columns.text("email").notNull().unique();
		}

		if (name === "hashedPassword") {
			return columns.text("hashedPassword").notNull();
		}
	}

	// ? user-defined fields — honor `required: true` as NOT NULL (Payload parity)
	const required = "required" in field && field.required === true;

	const withRequired = <T extends { notNull: () => T }>(col: T): T =>
		required ? col.notNull() : col;

	switch (field.type) {
		case "text":
			return withRequired(columns.text(name));

		case "number":
			// ? JS `number` is a float — use `real` so fractional values (price,
			// ? rating) survive. `integer` is reserved for ids/counters/system
			// ? columns. On SQLite both round-trip fine; on Postgres this is the
			// ? difference between a truncating INTEGER and a real numeric column.
			return withRequired(columns.real(name));

		case "boolean":
			return withRequired(columns.boolean(name));

		case "select":
			return withRequired(columns.text(name));

		case "upload":
			return withRequired(columns.text(name));

		default:
			return withRequired(columns.text(name));
	}
}
