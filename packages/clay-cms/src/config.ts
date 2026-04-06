import type { ClayCMSConfig } from "./types.js";

export { fields } from "./collections/fields.js";
export { resolveCollections } from "./collections/resolve.js";
export type {
	AfterChangeHook,
	AfterDeleteHook,
	BeforeChangeHook,
	BeforeDeleteHook,
	BooleanField,
	CollectionConfig,
	CollectionHooks,
	FieldAccess,
	FieldAccessContext,
	FieldAccessFn,
	FieldAccessOperation,
	FieldConfig,
	LocalizationConfig,
	NumberField,
	ResolvedCollectionConfig,
	SelectField,
	TextField,
	UploadField,
} from "./collections/types.js";
export type { ClayCMSConfig } from "./types.js";

// ? Identity helper that gives editor inference + type-checks the shape of
// ? a clay.config.ts file. Equivalent to `: ClayCMSConfig` but lets the user
// ? write `export default defineConfig({...})`.
export function defineConfig<T extends ClayCMSConfig>(config: T): T {
	return config;
}
