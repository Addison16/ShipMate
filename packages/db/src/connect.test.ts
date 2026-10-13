import { describe, expect, it } from "vitest";
import { socketDir } from "./connect.js";

describe("socketDir", () => {
  it("reads libpq's percent-encoded socket directory", () => {
    expect(socketDir("postgres://shipmate@%2Frun%2Fpostgresql/shipmate")).toBe("/run/postgresql");
  });

  it("leaves network hosts and bad URLs alone", () => {
    expect(socketDir("postgres://shipmate:pw@db:5432/shipmate")).toBeUndefined();
    expect(socketDir("postgres://shipmate:pw@192.168.1.10/shipmate")).toBeUndefined();
    expect(socketDir("not a url")).toBeUndefined();
  });
});
