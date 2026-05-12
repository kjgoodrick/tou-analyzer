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
