// ? access control types — collection-level ACL primitives shared by config, runtime gate, and consumer code

import type { Where } from "./where.js";

export type AccessOperation = "read" | "create" | "update" | "delete" | "admin";

export interface AccessContext {
	user: Record<string, unknown> | null;
	operation: AccessOperation;
	collection: string;
	id?: string;
	doc?: Record<string, unknown> | null;
}

// ? collection-level access fns may return boolean or a Where filter (Payload parity).
// ? field-level access (future) stays boolean-only.
export type AccessResult = boolean | Where;

export type AccessFn = (
	ctx: AccessContext,
) => AccessResult | Promise<AccessResult>;

// ? user-supplied access block — every op optional, missing ops fall back to tiered defaults in resolveCollections
export interface CollectionAccess {
	read?: AccessFn;
	create?: AccessFn;
	update?: AccessFn;
	delete?: AccessFn;
	admin?: AccessFn;
}

// ? post-resolve shape — read/create/update/delete are always populated; admin only on auth collections
export interface ResolvedCollectionAccess {
	read: AccessFn;
	create: AccessFn;
	update: AccessFn;
	delete: AccessFn;
	admin?: AccessFn;
}

export class AccessDeniedError extends Error {
	collection: string;
	operation: AccessOperation;

	constructor(
		collection: string,
		operation: AccessOperation,
		message?: string,
	) {
		super(
			message ??
				`[clay-cms] access denied: cannot ${operation} on collection "${collection}".`,
		);
		this.name = "AccessDeniedError";
		this.collection = collection;
		this.operation = operation;
	}
}
