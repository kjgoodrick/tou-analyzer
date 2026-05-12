# Privacy

The TOU Rate Analyzer is a static website with local-only processing.

- Usage data is parsed in the browser.
- Bill calculations and charts run in the browser.
- Imported data is saved only in this site's IndexedDB storage.
- The app has no backend, analytics, telemetry, or remote upload path.
- Clearing site data or using the app's clear control removes the saved import.

The optional extension bridge does not give websites direct access to extension
storage. It uses Chrome's externally connectable messaging API, requires an
allowlisted origin, and requires explicit user approval in the extension before
rows are shared with the analyzer.
