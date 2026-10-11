import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.js";
import { UpdateHouseholdSchema, UpdateProfileSchema } from "../services/profiles.js";
import type { Services } from "../services.js";

export async function profileRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/profile", async (req) => ({
    profile: await s.profiles.get(req.user.id),
    household: await s.profiles.household(),
  }));

  /** Anyone edits their own profile; nobody edits someone else's. */
  app.put("/api/profile", async (req) => ({
    profile: await s.profiles.set(req.user.id, UpdateProfileSchema.parse(req.body)),
  }));

  app.put("/api/household", async (req) => {
    requireRole(req.user, "admin");
    return { household: await s.profiles.setHousehold(UpdateHouseholdSchema.parse(req.body)) };
  });
}
