import { describe, expect, test } from "bun:test";
import { computeCell, type TableColumn } from "./genericView";

const col = (path: string): TableColumn => ({ path, label: "x" });

describe("computeCell path resolution", () => {
  test("'*' iterates array elements", () => {
    const item = { to: [{ namespace: "a" }, { namespace: "b" }] };
    expect(computeCell(item, {}, col("to/*/namespace"))).toEqual(["a", "b"]);
  });

  test("'*' iterates string-map values", () => {
    const item = { selector: { app: "nginx", tier: "web" } };
    expect(computeCell(item, {}, col("selector/*"))).toEqual(["nginx", "web"]);
  });

  test("'*' steps into map-of-objects to pull one field (only the integer)", () => {
    const item = { selector: { a: { name: "x", weight: 5 }, b: { name: "y", weight: 10 } } };
    expect(computeCell(item, {}, col("selector/*/weight"))).toEqual([5, 10]);
  });

  test("distinct values are deduplicated", () => {
    const item = { selector: { a: { weight: 5 }, b: { weight: 5 } } };
    expect(computeCell(item, {}, col("selector/*/weight"))).toEqual([5]);
  });

  test("'*key' lists the map keys", () => {
    const item = { selector: { app: "nginx", tier: "web" } };
    expect(computeCell(item, {}, col("selector/*key"))).toEqual(["app", "tier"]);
  });

  test("'*val' is an alias for values", () => {
    const item = { selector: { app: "nginx", tier: "web" } };
    expect(computeCell(item, {}, col("selector/*val"))).toEqual(["nginx", "web"]);
  });

  test("integer after an iterate picks the Nth value positionally", () => {
    const item = { selector: { app: "nginx", tier: "web" } };
    expect(computeCell(item, {}, col("selector/*val/0"))).toEqual(["nginx"]);
    expect(computeCell(item, {}, col("selector/*val/1"))).toEqual(["web"]);
    expect(computeCell(item, {}, col("selector/*/0"))).toEqual(["nginx"]); // "*" == "*val"
  });

  test("pick the Nth map entry, then drill into its field", () => {
    const item = { selector: { a: { name: "x", weight: 5 }, b: { name: "y", weight: 10 } } };
    expect(computeCell(item, {}, col("selector/*val/0/weight"))).toEqual([5]);
    expect(computeCell(item, {}, col("selector/*val/1/weight"))).toEqual([10]);
  });

  test("out-of-range positional index yields nothing", () => {
    const item = { selector: { app: "nginx" } };
    expect(computeCell(item, {}, col("selector/*val/5"))).toEqual([]);
  });

  test("integer without a preceding iterate still indexes an array (e.g. 'to/0')", () => {
    const item = { to: [{ namespace: "a" }, { namespace: "b" }] };
    expect(computeCell(item, {}, col("to/0/namespace"))).toBe("a");
  });

  test("plain path without '*' reads the value directly", () => {
    expect(computeCell({ port: 8080 }, {}, col("port"))).toBe(8080);
  });
});
