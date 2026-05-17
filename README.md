# TOU Rate Analyzer

Static, local-only analyzer for residential Schedule 1 and Schedule 1
time-of-use rates.

The app runs entirely in the browser. Usage files are parsed locally, saved in
this site's IndexedDB, and never sent to a server by the application.

## Development

```sh
npm install
npm run dev
npm run test
npm run build
```

## Deployment

Production is the Cloudflare Worker named `tou-analyzer` at
`https://offpeakadvisor.com`. Production deploys from the `main` branch only.

Configure Cloudflare Workers Builds for this repository with:

- Production branch: `main`
- Build command: `npm ci && npm run build`
- Production deploy command: `npx wrangler deploy`
- Non-production branch deploy command: `npx wrangler versions upload`
- Preview URLs: enabled

The repo also provides equivalent local commands:

```sh
npm run deploy
npm run deploy:preview
```

PR and non-production preview builds should omit
`VITE_UTILITY_ENERGY_DOWNLOADER_EXTENSION_ID` by default. Production builds
should set it to the published Chrome extension ID. If a preview build is
configured with the extension ID, the app may try the bridge, but the Chrome
extension's own `externally_connectable` and runtime origin allowlists are the
privacy boundary: preview URLs are not allowed to receive shared usage data
unless the extension is explicitly changed to trust a specific staging origin.

Before merging a PR, wait for GitHub CI and the Cloudflare preview deployment,
then test the preview URL. After the PR is merged, Cloudflare deploys production
from `main`.

## License

The TOU Rate Analyzer is distributed under the Pando Research Source Available
License v1. See `LICENSE.md`.

Third-party open source dependency license files are included under
`third_party/licenses`, with an index in `THIRD_PARTY_NOTICES.md`.

## Data Sources

Supported import paths:

- CSV and Parquet interval files.
- Approved CSV imports from the Utility Energy Downloader extension bridge.
  Approved extension imports are converted to Parquet in this browser for
  future reloads.
