import type { AdminConfig } from "../types.js";
import type { CollectionConfig, LocalizationConfig } from "./types.js";

export function validateCollections(
	collections: CollectionConfig[],
	localization?: LocalizationConfig,
	admin?: AdminConfig,
): void {
	if (collections.length === 0) {
		throw new Error("[clay-cms] At least one collection must be defined.");
	}

	// ? no duplicate slugs
	const slugs = new Set<string>();
	for (const c of collections) {
		if (slugs.has(c.slug)) {
			throw new Error(`[clay-cms] Duplicate collection slug: "${c.slug}".`);
		}

		slugs.add(c.slug);
	}

	// ? exactly one auth collection required
	const authCollections = collections.filter((c) => c.auth);

	if (authCollections.length === 0) {
		throw new Error(
			"[clay-cms] Exactly one collection must have `auth: true` for admin authentication.",
		);
	}

	if (authCollections.length > 1) {
		throw new Error(
			`[clay-cms] Only one collection can have \`auth: true\`. Found: ${authCollections.map((c) => `"${c.slug}"`).join(", ")}.`,
		);
	}

	// ? admin.user must be set and reference an auth-enabled collection
	if (!admin) {
		throw new Error(
			"[clay-cms] `admin.user` must be set to the slug of the auth collection that backs the admin dashboard (e.g. `admin: { user: users.slug }`).",
		);
	}

	const adminUserCollection = collections.find((c) => c.slug === admin.user);

	if (!adminUserCollection) {
		throw new Error(
			`[clay-cms] \`admin.user\` references collection "${admin.user}" which does not exist.`,
		);
	}

	if (!adminUserCollection.auth) {
		throw new Error(
			`[clay-cms] \`admin.user\` references collection "${admin.user}" which does not have \`auth: true\`.`,
		);
	}

	// ? cannot combine auth and upload on the same collection
	for (const c of collections) {
		if (c.auth && c.upload) {
			throw new Error(
				`[clay-cms] Collection "${c.slug}" cannot have both \`auth: true\` and \`upload: true\`.`,
			);
		}
	}

	// ? upload field relationTo targets exist and have upload: true
	const uploadSlugs = new Set(
		collections.filter((c) => c.upload).map((c) => c.slug),
	);

	for (const c of collections) {
		for (const [key, field] of Object.entries(c.fields)) {
			if (field.type === "upload") {
				if (!uploadSlugs.has(field.relationTo)) {
					throw new Error(
						`[clay-cms] Field "${key}" in collection "${c.slug}" references upload collection "${field.relationTo}" which either does not exist or does not have \`upload: true\`.`,
					);
				}
			}
		}
	}

	// ? localized fields require global localization config
	for (const c of collections) {
		for (const [key, field] of Object.entries(c.fields)) {
			if (
				(field.type === "text" || field.type === "select") &&
				field.localized &&
				!localization
			) {
				throw new Error(
					`[clay-cms] Field "${key}" in collection "${c.slug}" has \`localized: true\` but no \`localization\` config is defined.`,
				);
			}
		}
	}

	// ? access blocks — every defined op must be a function
	const validOps = new Set(["read", "create", "update", "delete", "admin"]);

	for (const c of collections) {
		if (!c.access) continue;
		for (const [op, fn] of Object.entries(c.access)) {
			if (!validOps.has(op)) {
				throw new Error(
					`[clay-cms] Collection "${c.slug}" has unknown access op "${op}". Valid ops: read, create, update, delete, admin.`,
				);
			}

			if (typeof fn !== "function") {
				throw new Error(
					`[clay-cms] Collection "${c.slug}" access.${op} must be a function.`,
				);
			}
		}

		if (c.access.admin && !c.auth) {
			throw new Error(
				`[clay-cms] Collection "${c.slug}" defines \`access.admin\` but is not an auth collection. The \`admin\` op is only meaningful on collections with \`auth: true\`.`,
			);
		}
	}

	// ? defaultLocale must be in locales array
	if (localization) {
		if (!localization.locales.includes(localization.defaultLocale)) {
			throw new Error(
				`[clay-cms] \`defaultLocale\` "${localization.defaultLocale}" is not included in \`locales\`: [${localization.locales.map((l) => `"${l}"`).join(", ")}].`,
			);
		}
	}
}
