import { describe, expect, test } from "bun:test";
import { compareSemver, isNewer, upgradeTargets } from "./semver";

describe("compareSemver", () => {
  test("core precedence", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0); // v prefix ignored
    expect(compareSemver("1.2.3+build", "1.2.3")).toBe(0); // build metadata ignored
  });

  test("pre-release ranks below its release", () => {
    expect(compareSemver("1.2.3", "1.2.3-rc1")).toBe(1);
    expect(compareSemver("1.2.3-rc1", "1.2.3")).toBe(-1);
  });

  test("pre-release identifiers compare per semver", () => {
    expect(compareSemver("1.2.3-rc.2", "1.2.3-rc.1")).toBe(1);
    expect(compareSemver("1.2.3-rc.1", "1.2.3-rc.2")).toBe(-1);
    expect(compareSemver("1.2.3-alpha", "1.2.3-beta")).toBe(-1);
    // numeric identifier ranks below alphanumeric
    expect(compareSemver("1.2.3-1", "1.2.3-alpha")).toBe(-1);
    // a larger identifier set ranks higher when leading ones equal
    expect(compareSemver("1.2.3-rc.1.1", "1.2.3-rc.1")).toBe(1);
  });
});

describe("isNewer", () => {
  test("a release is newer than its pre-release", () => {
    expect(isNewer("1.2.3", "1.2.3-rc1")).toBe(true);
    expect(isNewer("1.2.3-rc1", "1.2.3")).toBe(false);
  });
  test("empty inputs are not newer", () => {
    expect(isNewer("", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "")).toBe(false);
  });
});

describe("upgradeTargets", () => {
  test("strictly newer than current, not above approved, newest first", () => {
    const versions = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"];
    expect(upgradeTargets(versions, "1.0.0", "1.2.0")).toEqual(["1.2.0", "1.1.0"]);
  });
  test("no approved or approved not newer => no targets", () => {
    expect(upgradeTargets(["1.1.0"], "1.0.0")).toEqual([]);
    expect(upgradeTargets(["1.1.0"], "1.0.0", "1.0.0")).toEqual([]);
  });
});
