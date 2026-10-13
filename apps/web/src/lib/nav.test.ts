import { describe, expect, it } from "vitest";
import {
  activeNavId,
  MAIN_NAV,
  SETTINGS_SECTIONS,
  searchDestinations,
  settingsSectionFor,
  visibleSections,
} from "./nav.js";

const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe("settingsSectionFor", () => {
  it("reads the section from #/settings/<id> and treats bare #/settings as the overview", () => {
    expect(settingsSectionFor(["settings", "appearance"])).toBe("appearance");
    expect(settingsSectionFor(["settings"])).toBe("");
  });

  it("keeps the older top-level paths inside Settings", () => {
    expect(settingsSectionFor(["providers"])).toBe("providers");
    expect(settingsSectionFor(["bridges", "telegram"])).toBe("bridges");
    expect(settingsSectionFor(["discord"])).toBe("bridges");
    expect(settingsSectionFor(["skills", "abc"])).toBe("skills");
  });

  it("leaves everyday pages alone", () => {
    expect(settingsSectionFor(["bridge"])).toBeNull();
    expect(settingsSectionFor(["crew", "galley"])).toBeNull();
    expect(settingsSectionFor([])).toBeNull();
  });
});

describe("activeNavId", () => {
  it("highlights Settings for every settings screen and the page itself otherwise", () => {
    expect(activeNavId(["usage"])).toBe("settings");
    expect(activeNavId(["settings", "backups"])).toBe("settings");
    expect(activeNavId(["watches", "w1"])).toBe("watches");
    expect(activeNavId([])).toBe("bridge");
  });
});

describe("visibleSections", () => {
  it("hides owner and admin screens from members", () => {
    const member = ids(visibleSections({ role: "member" }));
    expect(member).not.toContain("backups");
    expect(member).not.toContain("users");
    expect(member).toContain("profile");
    const admin = ids(visibleSections({ role: "admin" }));
    expect(admin).toContain("users");
    expect(admin).not.toContain("backups");
    expect(ids(visibleSections({ role: "owner" }))).toEqual(ids(SETTINGS_SECTIONS));
  });
});

describe("searchDestinations", () => {
  const all = [...MAIN_NAV, ...SETTINGS_SECTIONS];

  it("finds places by the words people actually type", () => {
    expect(ids(searchDestinations(all, "discord"))[0]).toBe("bridges");
    expect(ids(searchDestinations(all, "password"))[0]).toBe("profile");
    expect(ids(searchDestinations(all, "api key"))[0]).toBe("providers");
    expect(ids(searchDestinations(all, "dark"))[0]).toBe("appearance");
    expect(ids(searchDestinations(all, "github"))[0]).toBe("shipyard");
  });

  it("ranks label matches above keyword matches", () => {
    expect(ids(searchDestinations(all, "backup"))[0]).toBe("backups");
  });

  it("returns everything for an empty query and nothing for nonsense", () => {
    expect(searchDestinations(all, "  ")).toHaveLength(all.length);
    expect(searchDestinations(all, "zzqx")).toEqual([]);
  });
});
