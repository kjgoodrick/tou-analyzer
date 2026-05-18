import { afterEach, describe, expect, it, vi } from "vitest";

const EXTENSION_ENV = "VITE_UTILITY_ENERGY_DOWNLOADER_EXTENSION_ID";

async function loadBridge(extensionId = "published-extension-id") {
  vi.resetModules();
  vi.stubEnv(EXTENSION_ENV, extensionId);
  return import("../src/extensionBridge");
}

describe("extension bridge deployment guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("enables the bridge when the extension ID is configured", async () => {
    const bridge = await loadBridge();

    expect(bridge.bridgeConfigured()).toBe(true);
  });

  it("keeps the bridge disabled when the extension ID is absent", async () => {
    const bridge = await loadBridge("");

    expect(bridge.bridgeConfigured()).toBe(false);
  });
});
