// ? schema builder contract types live in clay-cms (the core package) so that
// ? DrizzleAccessor can reference SchemaBuilderConfig without forming a type
// ? cycle with this package — see clay-cms/src/types.ts. We re-export here so
// ? intra-package imports (`import ... from "./types.js"`) keep working
// ? without churn, and so external consumers can keep importing from
// ? "@clay-cms/drizzle".

export type {
	ColumnBuilders,
	SchemaBuilderConfig,
	TableColumnInfo,
	TableConfigInfo,
	TableMap,
	TableUniqueConstraintInfo,
} from "clay-cms";
