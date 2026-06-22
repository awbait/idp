import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, errorMessage, HttpError } from "./client";

describe("errorMessage", () => {
  test("unwraps Error and HttpError messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new HttpError(500, null))).toBe("HTTP 500");
  });
  test("stringifies non-Error values", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("request timeout handling", () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;

  beforeEach(() => {
    // Stub the default-timeout signal so the test never schedules a real 30s timer.
    AbortSignal.timeout = (() => new AbortController().signal) as typeof AbortSignal.timeout;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  });

  test("maps a fetch TimeoutError to a friendly message", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new DOMException("timed out", "TimeoutError"))) as unknown as typeof fetch;
    await expect(api.listCharts()).rejects.toThrow("Превышено время ожидания ответа сервера");
  });

  test("rethrows a caller-initiated abort unchanged", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch;
    await expect(api.listCharts()).rejects.toMatchObject({ name: "AbortError" });
  });
});
