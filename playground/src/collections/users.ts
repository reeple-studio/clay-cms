import { isAdmin } from "clay-cms/access";
import { type CollectionConfig, fields } from "clay-cms/config";

export const users: CollectionConfig = {
	slug: "users",
	auth: true,
	labels: { singular: "User", plural: "Users" },
	fields: {
		name: fields.text({ required: true }),
		role: fields.select({
			options: ["admin", "editor", "customer"],
			required: true,
			// ? field-level ACL — only admins can change a user's role.
			// ? non-admins still see the field, but the admin UI renders the
			// ? select disabled and any submitted value is silently dropped
			// ? on the server.
			access: { update: isAdmin },
		}),
		// ? internal note visible only to admins. Non-admins never see this
		// ? field at all — find()/findOne() strip it before returning.
		internalNote: fields.text({
			access: {
				read: isAdmin,
				create: isAdmin,
				update: isAdmin,
			},
		}),
	},
};
