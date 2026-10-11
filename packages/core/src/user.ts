import { z } from "zod";

/** Roles are instance-wide. `owner` is created on first boot. */
export const UserRole = z.enum(["owner", "admin", "member"]);
export type UserRole = z.infer<typeof UserRole>;
