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

  test("plain path without '*' reads the value directly", () => {
    expect(computeCell({ port: 8080 }, {}, col("port"))).toBe(8080);
  });
});
