import type { HookParameters } from "astro";

import type {
	FieldConfig,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "../collections/types.js";

// ? slug → PascalCase singular interface name (`posts` → `Post`, `categories` → `Category`).
function pascal(slug: string): string {
	return slug
		.split(/[-_\s]+/)
		.map((p) => (p ? (p[0] ?? "").toUpperCase() + p.slice(1) : ""))
		.join("");
}

function singularize(name: string): string {
	if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
	if (name.endsWith("ses")) return name.slice(0, -2);
	if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);

	return name;
}

// ? exported so validateCollections can detect two slugs that collapse to the
// ? same generated interface name (post/posts → Post) at boot.
export function docTypeName(slug: string): string {
	return pascal(singularize(slug));
}

// ? Emit a property key safely: a bare identifier stays bare, anything else
// ? (hyphens, leading digits, spaces, reserved punctuation) is quoted so the
// ? generated .d.ts is always valid TS. validateCollections() rejects such
// ? slugs/field names at boot, but a stray key must never produce a broken
// ? interface that red-squiggles the user's whole project.
function tsPropKey(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function fieldToTs(field: FieldConfig): string {
	switch (field.type) {
		case "text":
			return "string";

		case "number":
			return "number";

		case "boolean":
			return "boolean";

		case "select": {
			const union =
				field.options.length > 0
					? field.options.map((o) => JSON.stringify(o)).join(" | ")
					: "string";

			return field.multiple ? `Array<${union}>` : union;
		}

		case "upload":
			// ? upload reference stored as the related doc id (string)
			return "string";
	}
}

function isOptional(field: FieldConfig): boolean {
	// ? hidden fields (e.g. hashedPassword) aren't returned by find/findOne unless
	// ? showHiddenFields is set (override-only), so the honest shape is optional —
	// ? a non-optional `hashedPassword: string` would type as present but be
	// ? undefined at runtime.
	if ("hidden" in field && field.hidden === true) return true;
	return !("required" in field) || field.required !== true;
}

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

function buildDocInterface(collection: ResolvedCollectionConfig): string {
	const lines: string[] = [];

	for (const [name, field] of Object.entries(collection.fields)) {
		const opt = isOptional(field) ? "?" : "";
		lines.push(`\t\t${tsPropKey(name)}${opt}: ${fieldToTs(field)};`);
	}

	return `\texport interface ${docTypeName(collection.slug)} {\n${lines.join("\n")}\n\t}`;
}

function buildCreateInputAlias(collection: ResolvedCollectionConfig): string {
	const name = docTypeName(collection.slug);

	return `\texport type ${name}CreateInput = Omit<${name}, ${[...SYSTEM_FIELDS]
		.map((f) => `"${f}"`)
		.join(" | ")}>;`;
}

function buildUpdateInputAlias(collection: ResolvedCollectionConfig): string {
	const name = docTypeName(collection.slug);

	return `\texport type ${name}UpdateInput = Partial<${name}CreateInput>;`;
}

// ? exported for unit tests — the generated type strings are the user-facing DX contract.
export function buildTypesContent(
	collections: ResolvedCollectionConfig[],
	localization?: LocalizationConfig,
): string {
	// ? Locale union — narrows `locale?: string` to the configured locales so
	// ? `cms.posts.find({ locale: "..." })` autocompletes against clay.config.ts.
	// ? When localization isn't configured the field is `never`, so passing one
	// ? becomes a type error (matching the runtime, which ignores it).
	const localeType =
		localization && localization.locales.length > 0
			? localization.locales.map((l) => JSON.stringify(l)).join(" | ")
			: "never";
	const docInterfaces = collections.map(buildDocInterface).join("\n\n");
	const createAliases = collections.map(buildCreateInputAlias).join("\n");
	const updateAliases = collections.map(buildUpdateInputAlias).join("\n");

	const collectionEntries = collections
		.map((c) => {
			const t = docTypeName(c.slug);
			return `\t\t${tsPropKey(c.slug)}: CollectionAPI<${t}, ${t}CreateInput, ${t}UpdateInput>;`;
		})
		.join("\n");

	return `declare namespace App {
		interface Locals {
			clayUser: Record<string, unknown> | null;
			claySession: import("clay-cms").AuthSession | null;
		}
	}

	declare module "virtual:clay-cms/drizzle" {
		import type { DrizzleAccessor } from "clay-cms";
		const drizzle: DrizzleAccessor;
		export default drizzle;
	}

	declare module "virtual:clay-cms/init-sql" {
		export default function ensureTables(): Promise<void>;
	}

	declare module "virtual:clay-cms/config" {
		import type { AdminConfig, LocalizationConfig, ResolvedCollectionConfig } from "clay-cms";
		const config: {
			collections: ResolvedCollectionConfig[];
			localization: LocalizationConfig | null;
			admin: AdminConfig;
			initSqlStatements: string[];
		};
		export default config;
	}

	declare module "virtual:clay-cms/api" {
		export type Locale = ${localeType};

		// ? Field projection — Payload-shaped. Include mode (\`{ field: true }\`)
		// ? returns only listed fields plus system fields. Exclude mode
		// ? (\`{ field: false }\`) omits the listed fields, keeps everything else.
		// ? Mixing throws at the gate. \`select\` is a perf knob, not a security
		// ? boundary — read-denied fields still get stripped after projection.
		// ?
		// ? Single mapped type (not a union of include/exclude shapes) so
		// ? contextual completion at the \`select: { | }\` cursor offers keys
		// ? of TDoc cleanly instead of falling back to global auto-import
		// ? suggestions. Mode is decoded in \`Project\` via \`Record<string, true>\`
		// ? / \`Record<string, false>\` constraints — pure-include and
		// ? pure-exclude literals still narrow the return type. Mixed mode
		// ? falls through to \`TDoc\` at the type level and throws at runtime.
		export type Select<TDoc> = { [K in keyof TDoc]?: boolean };

		type SystemField = "id" | "createdAt" | "updatedAt";

		// ? Project<Doc, S> — narrows the returned doc to the keys named in S.
		// ? Pure-include literal  → Pick<Doc, K | SystemField>.
		// ? Pure-exclude literal  → Omit<Doc, K>.
		// ? Mixed or undefined    → Doc passes through unchanged (mixed throws at runtime).
		export type Project<TDoc, S> =
			S extends undefined
				? TDoc
				: [S] extends [Record<string, true>]
					? Pick<TDoc, Extract<keyof S, keyof TDoc> | Extract<SystemField, keyof TDoc>>
					: [S] extends [Record<string, false>]
						? Omit<TDoc, Extract<keyof S, keyof TDoc>>
						: TDoc;

		${docInterfaces}

		${createAliases}

		${updateAliases}

		interface AccessOpts {
			user?: Record<string, unknown> | null;
			overrideAccess?: boolean;
		}
		interface CollectionAPI<
			TDoc = Record<string, unknown>,
			TCreate = Record<string, unknown>,
			TUpdate = Record<string, unknown>,
		> {
			// ? Two overloads per read op so the with-select signature carries
			// ? \`Select<TDoc>\` as the *concrete* contextual type for the literal.
			// ? Without the split TS resolves the generic default to \`undefined\`
			// ? and contextual completion falls back to global auto-imports
			// ? (astro:schema, astro:actions, etc.) inside the empty
			// ? \`select: { | }\` cursor — the standard idiom for "argument
			// ? presence changes return type" (Array.from / querySelector / etc.).
			find(
				opts?: { where?: Record<string, unknown>; locale?: Locale; showHiddenFields?: boolean; select?: undefined } & AccessOpts,
			): Promise<TDoc[]>;
			find<S extends Select<TDoc>>(
				opts: { where?: Record<string, unknown>; locale?: Locale; showHiddenFields?: boolean; select: S } & AccessOpts,
			): Promise<Project<TDoc, S>[]>;
			findOne(
				opts: { id: string; locale?: Locale; showHiddenFields?: boolean; select?: undefined } & AccessOpts,
			): Promise<TDoc | null>;
			findOne<S extends Select<TDoc>>(
				opts: { id: string; locale?: Locale; showHiddenFields?: boolean; select: S } & AccessOpts,
			): Promise<Project<TDoc, S> | null>;
			create(opts: { data: TCreate; locale?: Locale; requireEmpty?: boolean } & AccessOpts): Promise<TDoc>;
			update(opts: { id: string; data: TUpdate; locale?: Locale } & AccessOpts): Promise<TDoc>;
			delete(opts: { id: string } & AccessOpts): Promise<void>;
			can(
				op: "read" | "create" | "update" | "delete" | "admin",
				opts?: {
					id?: string;
					doc?: TDoc | null;
					data?: Partial<TCreate>;
				} & AccessOpts,
			): Promise<boolean>;
		}

		export interface CMS {
			${collectionEntries}
		}

		const cms: CMS;
		export default cms;
	}`;
}

export function injectClayTypes(
	params: HookParameters<"astro:config:done">,
	collections: ResolvedCollectionConfig[],
	localization?: LocalizationConfig,
) {
	params.injectTypes({
		filename: "clay-cms.d.ts",
		content: buildTypesContent(collections, localization),
	});
}
