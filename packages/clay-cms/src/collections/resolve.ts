import { authDefaults, contentDefaults } from "../access/defaults.js";
import type { ResolvedCollectionAccess } from "../access/types.js";
import type {
	CollectionConfig,
	FieldConfig,
	FieldLevelAccessFlags,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "./types.js";

const systemFields: Record<string, FieldConfig> = {
	id: { type: "text", required: true },
	createdAt: { type: "text", required: true },
	updatedAt: { type: "text", required: true },
};

const uploadFields: Record<string, FieldConfig> = {
	filename: { type: "text", required: true },
	mimeType: { type: "text", required: true },
	filesize: { type: "number", required: true },
	url: { type: "text", required: true },
	width: { type: "number" },
	height: { type: "number" },
};

const authFields: Record<string, FieldConfig> = {
	email: { type: "text", required: true },
	hashedPassword: { type: "text", required: true, hidden: true },
};

export function resolveCollections(
	collections: CollectionConfig[],
	localization?: LocalizationConfig,
): ResolvedCollectionConfig[] {
	return collections.map((collection) => {
		const fields: Record<string, FieldConfig> = {
			...systemFields,
			...(collection.upload ? uploadFields : {}),
			...(collection.auth ? authFields : {}),
			...collection.fields,
		};

		// ? per-op merge against tiered defaults — user can specify just one op without losing the rest
		const defaults = collection.auth ? authDefaults : contentDefaults;
		const userAccess = collection.access ?? {};

		const resolvedAccess: ResolvedCollectionAccess = {
			read: userAccess.read ?? defaults.read,
			create: userAccess.create ?? defaults.create,
			update: userAccess.update ?? defaults.update,
			delete: userAccess.delete ?? defaults.delete,
		};

		if (collection.auth) {
			// ? authDefaults.admin is always defined; the optionality on ResolvedCollectionAccess only reflects content collections
			const adminFn = userAccess.admin ?? authDefaults.admin;

			if (adminFn) {
				resolvedAccess.admin = adminFn;
			}
		}

		const resolved: ResolvedCollectionConfig = {
			slug: collection.slug,
			fields,
			access: resolvedAccess,
		};

		if (collection.labels) {
			resolved.labels = collection.labels;
		}

		if (collection.upload !== undefined) {
			resolved.upload = collection.upload;
		}

		if (collection.auth) {
			resolved.auth = true;
		}

		if (collection.hooks) {
			resolved.hooks = collection.hooks;
		}

		if (localization) {
			const hasLocalized = Object.values(fields).some(
				(f) => (f.type === "text" || f.type === "select") && f.localized,
			);

			if (hasLocalized) {
				resolved.hasLocalizedFields = true;
			}
		}

		// ? single field walk to set the field-level ACL hot-path flags. The
		// ? runtime gate skips the per-doc/per-write helpers entirely when
		// ? none of the fields on this collection define a rule for that op.
		const flags: FieldLevelAccessFlags = {};
		for (const field of Object.values(fields)) {
			const a = field.access;
			if (!a) continue;
			if (a.read) flags.read = true;
			if (a.create) flags.create = true;
			if (a.update) flags.update = true;
		}
		if (flags.read || flags.create || flags.update) {
			resolved.hasFieldLevelAccess = flags;
		}

		return resolved;
	});
}
