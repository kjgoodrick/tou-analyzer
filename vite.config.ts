import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash]-sample-fix.js"
      }
    }
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "e2e/**"]
  }
});
