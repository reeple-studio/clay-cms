// ? tiered access defaults — picked per-op by resolveCollections() based on `auth: true`

import { and, isAdmin, isLoggedIn, isSelf, or } from "./helpers.js";
import type { ResolvedCollectionAccess } from "./types.js";

// ? content collections (posts, pages, media…)
// ? read is public; writes require any logged-in user
export const contentDefaults: ResolvedCollectionAccess = {
	read: () => true,
	create: isLoggedIn,
	update: isLoggedIn,
	delete: isLoggedIn,
};

// ? auth collections (users, customers…)
// ? never publicly readable; writes are admin-only with carve-outs for self-update
// ? delete is admin-and-not-self; the immutable last-user invariant lives in the runtime gate (not user-overridable)
export const authDefaults: ResolvedCollectionAccess = {
	read: isLoggedIn,
	create: isAdmin,
	update: or(isAdmin, isSelf),
	delete: and(isAdmin, async (ctx) => !(await isSelf(ctx))),
	admin: isAdmin,
};
