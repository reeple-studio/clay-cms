import { clay } from "./integration.js";

export default clay;

export {
	type AccessContext,
	AccessDeniedError,
	type AccessFn,
	type AccessOperation,
	type CollectionAccess,
	type ResolvedCollectionAccess,
} from "./access/types.js";
export type { AuthSession } from "./auth/types.js";
export { fields } from "./collections/fields.js";
export { resolveCollections } from "./collections/resolve.js";
export type {
	AfterChangeHook,
	AfterDeleteHook,
	BeforeChangeHook,
	BeforeDeleteHook,
	BooleanField,
	CollectionHooks,
	FieldAccess,
	FieldAccessContext,
	FieldAccessFn,
	FieldAccessOperation,
	FieldConfig,
	NumberField,
	SelectField,
	TextField,
	UploadField,
} from "./collections/types.js";
export { validateCollections } from "./collections/validate.js";
export { defineConfig } from "./config.js";
export type {
	AdminConfig,
	ClayCMSConfig,
	CollectionConfig,
	ColumnBuilders,
	DatabaseAdapter,
	DatabaseAdapterResult,
	DrizzleAccessor,
	LocalizationConfig,
	ResolvedCollectionConfig,
	SchemaBuilderConfig,
	StorageAdapter,
	StorageAdapterResult,
	TableColumnInfo,
	TableConfigInfo,
	TableMap,
	TableUniqueConstraintInfo,
} from "./types.js";
export { clay };
