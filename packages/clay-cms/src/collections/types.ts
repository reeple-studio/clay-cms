// ? field-level access — boolean-only on purpose (Payload parity).
// ? Where-returning rules stay collection-level; the type prevents misuse.
// ? Three ops: read / create / update. No delete (fields aren't deleted
// ? independently of their doc), no admin (collection concept).

export type FieldAccessOperation = "read" | "create" | "update";

export interface FieldAccessContext {
	user: Record<string, unknown> | null;
	operation: FieldAccessOperation;
	collection: string;
	// ? present on read + update (the existing doc)
	doc?: Record<string, unknown> | null;
	// ? present on create + update (the incoming write)
	data?: Record<string, unknown>;
	// ? same as `data` today; reserved for when group/array/blocks land and
	// ? a hook fires inside a nested object — Payload parity.
	siblingData?: Record<string, unknown>;
}

export type FieldAccessFn = (
	ctx: FieldAccessContext,
) => boolean | Promise<boolean>;

export interface FieldAccess {
	read?: FieldAccessFn;
	create?: FieldAccessFn;
	update?: FieldAccessFn;
}

// ? base shared by every field variant. Keeps the per-field access knob in
// ? one place so a future field type doesn't have to remember to add it.
interface BaseField {
	required?: boolean;
	hidden?: boolean;
	access?: FieldAccess;
}

// ? field types

export interface TextField extends BaseField {
	type: "text";
	maxLength?: number;
	localized?: boolean;
}

export interface NumberField extends BaseField {
	type: "number";
	min?: number;
	max?: number;
}

export interface BooleanField extends BaseField {
	type: "boolean";
}

export interface SelectField extends BaseField {
	type: "select";
	options: string[];
	multiple?: boolean;
	localized?: boolean;
}

export interface UploadField extends BaseField {
	type: "upload";
	relationTo: string;
}

export type FieldConfig =
	| TextField
	| NumberField
	| BooleanField
	| SelectField
	| UploadField;

// ? localization

export interface LocalizationConfig {
	locales: [string, ...string[]];
	defaultLocale: string;
}

// ? access — re-exported from access module so collection configs can reference them inline

export type {
	AccessContext,
	AccessFn,
	AccessOperation,
	CollectionAccess,
	ResolvedCollectionAccess,
} from "../access/types.js";

import type {
	CollectionAccess,
	ResolvedCollectionAccess,
} from "../access/types.js";

// ? hooks
// ? Payload-shaped, runtime-agnostic. Differences from Payload:
// ?   - no `req` (no host coupling) — `user` and `context` are top-level
// ?   - hooks fire in the cms proxy, so bypass-mode (raw `cms` import) STILL runs them
// ?   - field-level hooks deferred (matches field-level ACL deferral)
// ? `context` is a per-operation scratchpad shared by every hook in one op
// ? (e.g. beforeChange → afterChange see the same object). Defaults to {}
// ? when the caller doesn't pass one. Use it for recursion guards, diffing
// ? between before/after, or stashing host state (Astro cookies, headers, locale).

export type HookContext = Record<string, unknown>;
export type HookUser = Record<string, unknown> | null;

export interface BeforeChangeHookArgs {
	data: Record<string, unknown>;
	originalDoc?: Record<string, unknown>;
	operation: "create" | "update";
	collection: string;
	user: HookUser;
	context: HookContext;
	id?: string;
}

export interface AfterChangeHookArgs {
	doc: Record<string, unknown>;
	previousDoc?: Record<string, unknown>;
	operation: "create" | "update";
	collection: string;
	user: HookUser;
	context: HookContext;
	id?: string;
}

export interface BeforeReadHookArgs {
	doc: Record<string, unknown>;
	collection: string;
	user: HookUser;
	context: HookContext;
}

export interface AfterReadHookArgs {
	doc: Record<string, unknown>;
	collection: string;
	user: HookUser;
	context: HookContext;
}

export interface BeforeDeleteHookArgs {
	id: string;
	doc: Record<string, unknown>;
	collection: string;
	user: HookUser;
	context: HookContext;
}

export interface AfterDeleteHookArgs {
	id: string;
	doc: Record<string, unknown>;
	collection: string;
	user: HookUser;
	context: HookContext;
}

export type BeforeChangeHook = (
	args: BeforeChangeHookArgs,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export type AfterChangeHook = (
	args: AfterChangeHookArgs,
) => void | Promise<void>;

export type BeforeReadHook = (
	args: BeforeReadHookArgs,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export type AfterReadHook = (
	args: AfterReadHookArgs,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export type BeforeDeleteHook = (
	args: BeforeDeleteHookArgs,
) => void | Promise<void>;

export type AfterDeleteHook = (
	args: AfterDeleteHookArgs,
) => void | Promise<void>;

export interface CollectionHooks {
	beforeChange?: BeforeChangeHook[];
	afterChange?: AfterChangeHook[];
	beforeRead?: BeforeReadHook[];
	afterRead?: AfterReadHook[];
	beforeDelete?: BeforeDeleteHook[];
	afterDelete?: AfterDeleteHook[];
}

// ? collection config

export interface CollectionConfig {
	slug: string;
	labels?: { singular?: string; plural?: string };
	upload?: boolean;
	auth?: boolean;
	hooks?: CollectionHooks;
	access?: CollectionAccess;
	fields: Record<string, FieldConfig>;
}

// ? Per-op booleans set by resolveCollections after a single field walk.
// ? The runtime gate consults this to skip the field-gate helpers entirely
// ? when no field on the collection defines an access rule for that op.
// ? Zero allocation cost for collections that don't use field-level ACL.
export interface FieldLevelAccessFlags {
	read?: boolean;
	create?: boolean;
	update?: boolean;
}

export interface ResolvedCollectionConfig {
	slug: string;
	labels?: { singular?: string; plural?: string };
	upload?: boolean;
	auth?: boolean;
	hooks?: CollectionHooks;
	hasLocalizedFields?: boolean;
	hasFieldLevelAccess?: FieldLevelAccessFlags;
	access: ResolvedCollectionAccess;
	fields: Record<string, FieldConfig>;
}
