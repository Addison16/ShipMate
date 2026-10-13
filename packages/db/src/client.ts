import { drizzle } from "drizzle-orm/postgres-js";
import { connect } from "./connect.js";
import * as schema from "./schema.js";

export function createDb(url: string) {
  const sql = connect(url, { max: 10 });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
export type Db = ReturnType<typeof createDb>["db"];
