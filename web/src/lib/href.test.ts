import { describe, expect, test } from "bun:test";
import { safeHref } from "./href";

describe("safeHref", () => {
  test("passes http(s) URLs", () => {
    expect(safeHref("https://gitlab/mr/1")).toBe("https://gitlab/mr/1");
    expect(safeHref("http://argocd:8083/app")).toBe("http://argocd:8083/app");
    expect(safeHref("HTTPS://x")).toBe("HTTPS://x");
  });
  test("rejects dangerous or non-http schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,x")).toBeUndefined();
    expect(safeHref("ftp://x")).toBeUndefined();
    expect(safeHref("/relative")).toBeUndefined();
  });
  test("handles empty / nullish", () => {
    expect(safeHref("")).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
  });
});
