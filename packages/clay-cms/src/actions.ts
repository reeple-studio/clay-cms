import { z } from "astro/zod";
import { AccessDeniedError, evaluateFieldAccess } from "clay-cms/access";

import { ActionError, defineAction } from "astro:actions";
import cms, { INTERNAL_DB, INTERNAL_TABLES } from "virtual:clay-cms/api";
import config from "virtual:clay-cms/config";

const { collections, admin } = config;

import {
	checkRateLimit,
	clearRateLimit,
	createSession,
	deleteSession,
	deleteSessionCookie,
	fakeVerifyPassword,
	getSessionToken,
	hashPassword,
	setSessionCookie,
	verifyPassword,
} from "clay-cms/auth";

// ? best-effort per-IP rate limit key. context.clientAddress can throw on
// ? adapters that don't expose it; fall back to a shared bucket so the limit
// ? still applies (as a global floor) rather than silently disabling.
function rateKey(context: { clientAddress?: string }, action: string): string {
	let ip: string;
	try {
		ip = context.clientAddress ?? "unknown";
	} catch {
		ip = "unknown";
	}
	return `${action}:${ip}`;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const server = {
	cms: {
		setup: defineAction({
			accept: "form",
			input: z.object({
				name: z.string().min(1, "Name is required"),
				// ? normalize to lowercase so the case-sensitive SQLite UNIQUE index
				// ? can't hold Admin@x.com AND admin@x.com as two accounts, and login
				// ? (which also normalizes) always matches the stored value.
				email: z
					.email("Invalid email address")
					.transform((e) => e.trim().toLowerCase()),
				// ? bcrypt only hashes the first 72 bytes — cap here so a user can't
				// ? believe a longer passphrase is fully protecting the account.
				password: z
					.string()
					.min(8, "Password must be at least 8 characters")
					.max(72, "Password must be at most 72 characters"),
			}),
			handler: async (input, context) => {
				// ? admin.user is validated at boot to reference an auth collection
				const authSlug = admin!.user;

				const db = await cms[INTERNAL_DB]();
				const tables = cms[INTERNAL_TABLES]();

				// ? throttle setup attempts per IP (3/hour). On a hit, return the
				// ? same generic error as a completed-setup attempt so no state leaks.
				const allowed = await checkRateLimit(
					db,
					tables._rate_limits,
					rateKey(context, "setup"),
					3,
					HOUR,
				);
				if (!allowed) {
					throw new ActionError({
						code: "FORBIDDEN",
						message: "Setup unavailable.",
					});
				}

				const hashedPassword = await hashPassword(input.password);

				// ? force the very first user to role: "admin" — guarantees they can
				// ? manage others. requireEmpty makes the "no users yet" check and the
				// ? insert one atomic statement, so two concurrent setups with
				// ? different emails can't both create an admin (the loser gets null).
				// ? overrideAccess bypasses the auth create gate (isAdmin by default).
				const user = (await cms[authSlug]!.create({
					data: {
						name: input.name,
						email: input.email,
						hashedPassword,
						role: "admin",
					},
					overrideAccess: true,
					requireEmpty: true,
				})) as Record<string, unknown> | null;

				// ? null → setup already happened (or raced). Generic error, no
				// ? disclosure that users exist to an unauthenticated caller.
				if (!user) {
					throw new ActionError({
						code: "FORBIDDEN",
						message: "Setup unavailable.",
					});
				}

				const session = await createSession(
					db,
					tables._sessions,
					user.id as string,
				);

				setSessionCookie(context.cookies, session.token);

				return {
					userId: user.id as string,
				};
			},
		}),

		login: defineAction({
			accept: "form",
			input: z.object({
				// ? normalize to match the stored (lowercased) email — see setup.
				email: z
					.email("Invalid email address")
					.transform((e) => e.trim().toLowerCase()),
				// ? no max here: bcrypt.compare truncates the input to 72 bytes too,
				// ? so a longer paste still matches a legitimately-set password.
				password: z.string().min(8, "Password is required"),
			}),
			handler: async (input, context) => {
				const authSlug = admin!.user;

				const db = await cms[INTERNAL_DB]();
				const tables = cms[INTERNAL_TABLES]();

				// ? throttle login attempts per IP (5/15min). On a hit, return the
				// ? same generic error as a bad password so an attacker can't tell
				// ? "rate-limited" from "wrong credentials".
				const allowed = await checkRateLimit(
					db,
					tables._rate_limits,
					rateKey(context, "login"),
					5,
					15 * MINUTE,
				);
				if (!allowed) {
					throw new ActionError({
						code: "UNAUTHORIZED",
						message: "Invalid email or password.",
					});
				}

				// ? login happens pre-auth — explicit bypass to look up the user by email.
				const users = await cms[authSlug]!.find({
					where: { email: { equals: input.email } },
					showHiddenFields: true,
					overrideAccess: true,
				});

				const user = users[0] as Record<string, unknown> | undefined;

				// ? constant-time: run a bcrypt verify on BOTH branches. When the
				// ? user isn't found we still burn one bcrypt against a constant
				// ? hash, so response latency can't reveal whether the email exists.
				const valid = user
					? await verifyPassword(input.password, user.hashedPassword as string)
					: await fakeVerifyPassword(input.password);

				if (!user || !valid) {
					throw new ActionError({
						code: "UNAUTHORIZED",
						message: "Invalid email or password.",
					});
				}

				// ? successful login → clear the per-IP login budget so a shared IP
				// ? isn't locked out by its own valid logins (and the row is pruned).
				await clearRateLimit(
					db,
					tables._rate_limits,
					rateKey(context, "login"),
				);

				// ? rotate: kill the cookie the caller held before login so a
				// ? pre-login session token is dead afterwards (session fixation).
				const existingToken = getSessionToken(context.cookies);
				if (existingToken) {
					await deleteSession(db, tables._sessions, existingToken);
				}

				const session = await createSession(
					db,
					tables._sessions,
					user.id as string,
				);

				setSessionCookie(context.cookies, session.token);

				return { userId: user.id as string };
			},
		}),

		logout: defineAction({
			accept: "form",
			input: z.object({}),
			handler: async (_input, context) => {
				const token = getSessionToken(context.cookies);

				if (token) {
					const db = await cms[INTERNAL_DB]();
					const tables = cms[INTERNAL_TABLES]();
					await deleteSession(db, tables._sessions, token);
				}

				deleteSessionCookie(context.cookies);

				return { success: true };
			},
		}),

		updateEntry: defineAction({
			accept: "form",
			input: z.looseObject({
				_slug: z.string(),
				_id: z.string(),
			}),
			handler: async (input, context) => {
				const collection = (
					collections as {
						slug: string;
						fields: Record<
							string,
							{
								type: string;
								hidden?: boolean;
								maxLength?: number;
								options?: string[];
								min?: number;
								max?: number;
							}
						>;
					}[]
				).find((c) => c.slug === input._slug);

				if (!collection) {
					throw new ActionError({
						code: "NOT_FOUND",
						message: "Collection not found.",
					});
				}

				const badRequest = (message: string): never => {
					throw new ActionError({ code: "BAD_REQUEST", message });
				};

				const systemKeys = new Set([
					"_slug",
					"_id",
					"id",
					"createdAt",
					"updatedAt",
					"filename",
					"mimeType",
					"filesize",
					"url",
					"width",
					"height",
					"hashedPassword",
				]);

				const data: Record<string, unknown> = {};

				// ? field-level read/update permissions for the acting user. A field
				// ? the user can't read (or can't update) is never rendered as an
				// ? editable input, so its ABSENCE from the form must not be read as a
				// ? value. This matters most for booleans: "unchecked" and "not
				// ? rendered" both arrive as a missing key, and coercing the latter to
				// ? false silently reset a hidden boolean on every unrelated save.
				const fieldPerms = await evaluateFieldAccess(
					collection as unknown as Parameters<typeof evaluateFieldAccess>[0],
					null,
					(context.locals.clayUser ?? null) as Record<string, unknown> | null,
				);

				// ? validate every accepted field against its resolved config, server-side.
				// ? z.looseObject lets arbitrary keys through, and per-field constraints
				// ? (maxLength / select options / number range) are declarative config
				// ? that nothing else enforces — so we enforce them here. Drops the
				// ? DoS-via-giant-text vector and rejects out-of-enum / out-of-range input.
				for (const [key, fieldConfig] of Object.entries(collection.fields)) {
					if (systemKeys.has(key)) continue;
					if ("hidden" in fieldConfig && fieldConfig.hidden) continue;

					const raw = input[key];

					if (fieldConfig.type === "number") {
						if (raw === "" || raw === undefined) {
							data[key] = null;
							continue;
						}
						const n = Number(raw);
						if (Number.isNaN(n)) {
							badRequest(`Field "${key}" must be a number.`);
						}
						if (typeof fieldConfig.min === "number" && n < fieldConfig.min) {
							badRequest(`Field "${key}" must be ≥ ${fieldConfig.min}.`);
						}
						if (typeof fieldConfig.max === "number" && n > fieldConfig.max) {
							badRequest(`Field "${key}" must be ≤ ${fieldConfig.max}.`);
						}
						data[key] = n;
					} else if (fieldConfig.type === "boolean") {
						// ? only coerce a missing checkbox to false when this field was
						// ? actually rendered as an editable checkbox for the user
						// ? (readable AND updatable). Otherwise a missing key means "not
						// ? on the form" — leave the stored value untouched.
						const perms = fieldPerms.get(key);
						if (perms && (!perms.canRead || !perms.canUpdate)) continue;
						// ? unchecked checkboxes don’t submit — treat missing as false
						data[key] = raw === "on";
					} else if (fieldConfig.type === "select") {
						if (raw === undefined) continue;
						const value = String(raw);
						if (fieldConfig.options && !fieldConfig.options.includes(value)) {
							badRequest(`Field "${key}" has an invalid option.`);
						}
						data[key] = value;
					} else {
						// ? text and everything else string-shaped
						if (raw === undefined) continue;
						if (
							typeof raw === "string" &&
							typeof fieldConfig.maxLength === "number" &&
							raw.length > fieldConfig.maxLength
						) {
							badRequest(
								`Field "${key}" exceeds the maximum length of ${fieldConfig.maxLength}.`,
							);
						}
						data[key] = raw;
					}
				}

				try {
					// ? collection existence already checked above
					// ? thread the current session user so the gate enforces against them
					const doc = await cms[input._slug]!.update({
						id: input._id,
						data,
						user: context.locals.clayUser,
					});

					return { doc };
				} catch (err) {
					if (err instanceof AccessDeniedError) {
						throw new ActionError({
							code: "FORBIDDEN",
							message: err.message,
						});
					}

					throw err;
				}
			},
		}),

		deleteEntry: defineAction({
			accept: "form",
			input: z.object({
				slug: z.string(),
				id: z.string(),
			}),
			handler: async (input, context) => {
				try {
					await cms[input.slug]!.delete({
						id: input.id,
						user: context.locals.clayUser,
					});

					return { success: true };
				} catch (err) {
					if (err instanceof AccessDeniedError) {
						throw new ActionError({
							code: "FORBIDDEN",
							message: err.message,
						});
					}

					throw err;
				}
			},
		}),
	},
};
