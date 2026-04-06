import type { Where } from "./access/where.js";
import type {
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "./collections/types.js";

export type {
	CollectionConfig,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "./collections/types.js";

// ? schema builder contract — see ROADMAP P0 #3.
// ? Lives in clay-cms (not @clay-cms/drizzle) on purpose: it's a core adapter
// ? contract referenced by DrizzleAccessor below, and putting it here breaks
// ? the type cycle with @clay-cms/drizzle (which imports ResolvedCollectionConfig
// ? from clay-cms). @clay-cms/drizzle re-exports these from its own types.ts
// ? for ergonomic intra-package imports.

// ? semantic column vocabulary. Each builder is `(name) => ColumnBuilder`;
// ? dialect knobs (mode flags, jsonb vs text) are adapter-internal and never
// ? leak into the dialect-agnostic schema builder.
// ? JS-shape contract (Payload-aligned): text→string, integer→number,
// ? boolean→boolean, timestamp→ISO-8601 string, json→parsed JS value.
export interface ColumnBuilders {
	// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	text: (name: string) => any;
	// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	integer: (name: string, config?: any) => any;
	// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	boolean: (name: string) => any;
	// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	timestamp: (name: string) => any;
	// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	json: (name: string) => any;
}

// ? dialect-agnostic table introspection results.
export interface TableColumnInfo {
	name: string;
	getSQLType(): string;
	primary: boolean;
	notNull: boolean;
	isUnique: boolean;
}

export interface TableUniqueConstraintInfo {
	columns: { name: string }[];
}

export interface TableConfigInfo {
	name: string;
	columns: TableColumnInfo[];
	uniqueConstraints: TableUniqueConstraintInfo[];
}

export interface SchemaBuilderConfig {
	tableFactory: (
		name: string,
		// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
		columns: Record<string, any>,
		// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
		extraConfig?: (table: any) => Record<string, any>,
		// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	) => any;
	columns: ColumnBuilders;
	unique?: (name?: string) => {
		// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
		on: (...columns: any[]) => any;
	};
	// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
	getTableConfig?: (table: any) => TableConfigInfo;
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-abstraction boundary
export type TableMap = Record<string, any>;

// ? drizzle accessor — every db adapter must expose this so the runtime
// ? proxy (runtime/api.ts) stays dialect-agnostic. The adapter ecosystem
// ? itself is the registry; `provider` is informational metadata.

export interface DrizzleAccessor {
	// biome-ignore lint/suspicious/noExplicitAny: drizzle instance is dialect-dependent
	getDb(): Promise<any>;
	provider: "sqlite" | "pg" | "mysql";
	schemaConfig: SchemaBuilderConfig;
}

// ? database adapter

export interface DatabaseAdapter {
	name: string;

	connect(): Promise<void>;
	disconnect(): Promise<void>;

	find(
		collection: string,
		query?: Where,
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

export interface DatabaseAdapterResult {
	name: string;
	drizzle?: DrizzleAccessor;

	// ? ES module code that default-exports a DrizzleAccessor.
	// ? used to create a Vite virtual module so the accessor is available in the SSR runtime (e.g. workerd) where integration hooks can’t set globalThis.
	drizzleModuleCode?: string;

	// ? generates CREATE TABLE IF NOT EXISTS SQL for all tables (collections + _sessions).
	// ? called by the integration at config time — the SQL is served via a virtual module so it can run in the SSR runtime (e.g. workerd).
	generateInitSQL?: (
		collections: ResolvedCollectionConfig[],
		localization?: LocalizationConfig,
	) => string[];
	init: (
		collections: ResolvedCollectionConfig[],
		localization?: LocalizationConfig,
	) => DatabaseAdapter;
}

// ? storage adapter

export interface StorageAdapter {
	name: string;

	handleUpload(
		path: string,
		data: ArrayBuffer | Uint8Array,
		contentType: string,
	): Promise<{ url: string }>;
	handleDelete(path: string): Promise<void>;
	staticHandler(path: string): Promise<Response>;
	generateUrl(path: string): string;
}

export interface StorageAdapterResult {
	name: string;
	init: () => StorageAdapter;
}

// ? cms config

export interface ClayCMSConfig {
	db: DatabaseAdapterResult;
	storage: StorageAdapterResult;
	collections: import("./collections/types.js").CollectionConfig[];
	localization?: LocalizationConfig;
	admin?: AdminConfig;
}

export interface AdminConfig {
	// ? Slug of the auth-enabled collection that backs the admin dashboard.
	user: string;
}
