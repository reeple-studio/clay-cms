import { ActionError, defineAction } from "astro:actions";
import cms from "virtual:clay-cms/api";
import config from "virtual:clay-cms/config";
import { z } from "astro/zod";
import { AccessDeniedError } from "clay-cms/access";

const { collections, admin } = config;

import {
	createSession,
	deleteSession,
	deleteSessionCookie,
	getSessionToken,
	hashPassword,
	setSessionCookie,
	verifyPassword,
} from "clay-cms/auth";

export const server = {
	cms: {
		setup: defineAction({
			accept: "form",
			input: z.object({
				name: z.string().min(1, "Name is required"),
				email: z.email("Invalid email address"),
				password: z.string().min(8, "Password must be at least 8 characters"),
			}),
			handler: async (input, context) => {
				// ? admin.user is validated at boot to reference an auth collection
				const authSlug = admin!.user;
				// ? bootstrap path: there's no user yet, so the gate would deny.
				// ? Explicit bypass — this is the canonical "act as system" call.
				const users = await cms[authSlug]!.find({
					overrideAccess: true,
				});

				if (users.length > 0) {
					throw new ActionError({
						code: "FORBIDDEN",
						message: "Setup already completed.",
					});
				}

				const hashedPassword = await hashPassword(input.password);

				// ? force the very first user to role: "admin" — guarantees they can manage others
				// ? overrideAccess: true bypasses the auth-collection's create gate (which is isAdmin by default)
				const user = await cms[authSlug]!.create({
					data: {
						name: input.name,
						email: input.email,
						hashedPassword,
						role: "admin",
					},
					overrideAccess: true,
				});

				const db = await cms.__db();
				const tables = cms.__tables();

				const session = await createSession(
					db,
					tables._sessions,
					(user as Record<string, unknown>).id as string,
				);

				setSessionCookie(context.cookies, session.token);

				return {
					userId: (user as Record<string, unknown>).id as string,
				};
			},
		}),

		login: defineAction({
			accept: "form",
			input: z.object({
				email: z.email("Invalid email address"),
				password: z.string().min(8, "Password is required"),
			}),
			handler: async (input, context) => {
				const authSlug = admin!.user;

				// ? login happens pre-auth — explicit bypass to look up the user by email.
				const users = await cms[authSlug]!.find({
					where: { email: input.email },
					showHiddenFields: true,
					overrideAccess: true,
				});

				if (users.length === 0) {
					throw new ActionError({
						code: "UNAUTHORIZED",
						message: "Invalid email or password.",
					});
				}

				const user = users[0] as Record<string, unknown>;
				const valid = await verifyPassword(
					input.password,
					user.hashedPassword as string,
				);

				if (!valid) {
					throw new ActionError({
						code: "UNAUTHORIZED",
						message: "Invalid email or password.",
					});
				}

				const db = await cms.__db();
				const tables = cms.__tables();

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
					const db = await cms.__db();
					const tables = cms.__tables();
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
						fields: Record<string, { type: string; hidden?: boolean }>;
					}[]
				).find((c) => c.slug === input._slug);

				if (!collection) {
					throw new ActionError({
						code: "NOT_FOUND",
						message: "Collection not found.",
					});
				}

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

				for (const [key, fieldConfig] of Object.entries(collection.fields)) {
					if (systemKeys.has(key)) continue;
					if ("hidden" in fieldConfig && fieldConfig.hidden) continue;

					const raw = input[key];

					if (fieldConfig.type === "number") {
						data[key] = raw === "" || raw === undefined ? null : Number(raw);
					} else if (fieldConfig.type === "boolean") {
						// ? unchecked checkboxes don’t submit — treat missing as false
						data[key] = raw === "on";
					} else {
						if (raw !== undefined) {
							data[key] = raw;
						}
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
