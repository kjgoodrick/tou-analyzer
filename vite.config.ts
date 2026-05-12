import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 900
  },
  test: {
    environment: "node"
  }
});
