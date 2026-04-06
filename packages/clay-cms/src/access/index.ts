// ? barrel — public surface of clay-cms/access

export { authDefaults, contentDefaults } from "./defaults.js";
export {
	applyReadFieldAccess,
	applyWriteFieldAccess,
	evaluateFieldAccess,
	type FieldPermissions,
} from "./field-gate.js";
export {
	and,
	isAdmin,
	isLoggedIn,
	isSelf,
	not,
	or,
	ownDocuments,
} from "./helpers.js";
export {
	type AccessContext,
	AccessDeniedError,
	type AccessFn,
	type AccessOperation,
	type AccessResult,
	type CollectionAccess,
	type ResolvedCollectionAccess,
} from "./types.js";
export {
	andWhere,
	matchesWhere,
	orWhere,
	type Where,
	type WhereField,
	type WhereOperator,
} from "./where.js";
