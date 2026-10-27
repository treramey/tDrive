# tdrive verification map

Read this index before driving the app. These files are the maintained source for user journeys; update them when routes, controls, or CLI commands change.

## Baseline preconditions

- Run `control.py new`, `launch RUN`, and `doctor RUN` as described in [SKILL.md](../SKILL.md).
- The app starts empty, with one CLI fixture key. Inputs exist on disk but have not been uploaded. Authenticate in a fresh browser context.
- `CONTROL` is the absolute path to `control.py`; `RUN` is the absolute run path it printed. Shell variables do not survive every tool invocation; pass literal recorded paths when necessary.
- Before search, tags, versions, trash, or sharing tests, create the required corpus through the mapped upload journey. Missing preconditions are failures with reasons, never grounds to simplify a journey.
- Names such as `FILE_ID`, `SITE_ID`, and `TAG_ID` in commands mean IDs observed in this run's output.

## Driving conventions

Use fresh ARIA refs from `preview_snapshot` with `preview_act`; upload using the real file input. Prefer accessible labels and names over layout. Each feature below uses the browser/CLI/HTTP harness documented in the skill. CLI runs are isolated processes; device authorization additionally needs an isolated XDG directory. Do not drive an instance you did not launch.

## Proof and skip reporting

Capture action plus resulting state, UI identity and snapshots, command/stdout/stderr/exit code, and a second read for persisted effects. Record feature IDs and **each** entry point. Exercising one does not verify the others. Mark unsupported or unmet journeys explicitly FAIL or SKIPPED with reason; never claim full map coverage from one convenient path. The generator only needs to prove one mapped journey once; later task verification should select all relevant entries.

## Features

- [Authentication and credentials](authentication.md): browser sign-in, API fallback, sign-out, API key scope/revocation, CLI device authorization.
- [Upload, preview, and download](transfer.md): toolbar and empty-state upload, drag/drop and paste, CLI file/stdin upload, public/private byte transfer.
- [File lifecycle and versions](lifecycle.md): rename, replacement and historical downloads, restore, trash and permanent deletion.
- [Search, browsing, and tags](search-tags.md): search box/keyboard, views/sorting, tag creation/assignment/filtering, CLI tags.
- [Publish a site](sites.md): CLI create/republish, dashboard site entry, stable public URL, relative assets.
