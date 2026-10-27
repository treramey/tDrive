# Generator validation

Proved the generated instructions on 2026-10-27 against tdrive source `c55e7cae5e3b7232d629aa1a06bfa3c25513286c`. [Full retained report](/home/tmr/.local/state/adrive-verification/b484c71c-a391-4483-9ae3-f175f2787367/evidence/report.md).

PASS: empty-state cancel and toolbar upload, reload/reopen, metadata, anonymous byte equality, browser sign-out, CLI JSON/status and stdout byte equality, HTTP helper, and cleanup with evidence surviving. Both local ports and the ephemeral browser container were gone after cleanup.

The primary shared browser lacked host libraries; verification used the documented Docker Playwright fallback. This supplies Chromium/Ubuntu libraries and uses host networking. Native shared-browser setup and production Cloudflare behavior remain unverified. The app ran with real local D1/R2/KV emulators, its content proxy, all migrations, and isolated fixture auth. Other mapped journeys remain unverified; see the report for scope, earlier failed iterations, and evidence.
