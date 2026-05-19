import { describe, expect, it } from "vitest";

import { canonicalizeRequestUrl } from "../src/worker";

describe("canonicalizeRequestUrl", () => {
  it("redirects apex HTTP requests to the HTTPS www canonical host", () => {
    expect(canonicalizeRequestUrl("http://offpeakadvisor.com/")).toBe(
      "https://www.offpeakadvisor.com/"
    );
  });

  it("redirects www HTTP requests to HTTPS", () => {
    expect(canonicalizeRequestUrl("http://www.offpeakadvisor.com/")).toBe(
      "https://www.offpeakadvisor.com/"
    );
  });

  it("redirects apex HTTPS requests to the www canonical host", () => {
    expect(canonicalizeRequestUrl("https://offpeakadvisor.com/rates/?q=1")).toBe(
      "https://www.offpeakadvisor.com/rates/?q=1"
    );
  });

  it("does not redirect canonical HTTPS www requests", () => {
    expect(canonicalizeRequestUrl("https://www.offpeakadvisor.com/")).toBeNull();
  });

  it("does not redirect preview or local development hosts", () => {
    expect(canonicalizeRequestUrl("https://tou-analyzer.example.workers.dev/")).toBeNull();
    expect(canonicalizeRequestUrl("http://127.0.0.1:8787/")).toBeNull();
  });
});
