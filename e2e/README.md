# Playwright Tests

Browser tests use Playwright against the local Vite app.

```sh
npm run test:e2e
npm run test:e2e:ui
npm run test:perf
```

`test:perf` records scroll metrics as Playwright artifacts. The performance test is report-only and does not enforce FPS or long-task thresholds yet.
