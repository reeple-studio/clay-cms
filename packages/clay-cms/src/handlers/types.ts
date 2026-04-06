import type { HookParameters } from "astro";
import type {
	FieldConfig,
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

function docTypeName(slug: string): string {
	return pascal(singularize(slug));
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
	return !("required" in field) || field.required !== true;
}

const SYSTEM_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

function buildDocInterface(collection: ResolvedCollectionConfig): string {
	const lines: string[] = [];

	for (const [name, field] of Object.entries(collection.fields)) {
		const opt = isOptional(field) ? "?" : "";
		lines.push(`\t\t${name}${opt}: ${fieldToTs(field)};`);
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
): string {
	const docInterfaces = collections.map(buildDocInterface).join("\n\n");
	const createAliases = collections.map(buildCreateInputAlias).join("\n");
	const updateAliases = collections.map(buildUpdateInputAlias).join("\n");

	const collectionEntries = collections
		.map((c) => {
			const t = docTypeName(c.slug);
			return `\t\t${c.slug}: CollectionAPI<${t}, ${t}CreateInput, ${t}UpdateInput>;`;
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
			find(opts?: { where?: Record<string, unknown>; locale?: string; showHiddenFields?: boolean } & AccessOpts): Promise<TDoc[]>;
			findOne(opts: { id: string; locale?: string; showHiddenFields?: boolean } & AccessOpts): Promise<TDoc | null>;
			create(opts: { data: TCreate; locale?: string } & AccessOpts): Promise<TDoc>;
			update(opts: { id: string; data: TUpdate; locale?: string } & AccessOpts): Promise<TDoc>;
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

			__tables: () => Record<string, unknown>;
			__db: () => Promise<unknown>;
			[key: string]: CollectionAPI | (() => Record<string, unknown>) | (() => Promise<unknown>);
		}

		const cms: CMS;
		export default cms;
	}`;
}

export function injectClayTypes(
	params: HookParameters<"astro:config:done">,
	collections: ResolvedCollectionConfig[],
) {
	params.injectTypes({
		filename: "clay-cms.d.ts",
		content: buildTypesContent(collections),
	});
}
