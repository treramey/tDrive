# Upload, preview, and download

Users upload files, select visibility/expiration, preview them, and retrieve the original bytes through a separate content origin.

## Sub-features

- `transfer-browser`: upload dialog, cancellation, progress, persisted listing/detail.
- `transfer-shortcuts`: dashboard drag/drop, dialog drop, and pasted files.
- `transfer-cli`: file and stdin uploads, file and stdout downloads.
- `transfer-sharing`: public content, private grants, HTML forced public, previews.

## How to get to it (user POV)

- Choose toolbar `Upload` (or keyboard `u` outside fields), or `Upload files` in the empty-state listing.
- Drag a file onto the dashboard or the upload dialog; paste a file on the dashboard or while the dialog is open.
- Run `bun tdrive put FILE`, or pipe bytes into `bun tdrive put - --name NAME`.
- Open a listing link named `Open verify-note.txt`; use the detail page's `Open`/`Download`, `Copy link`, or `Copy temporary link`, or run `bun tdrive get ID --output FILE`.

## Driving it with browser/CLI/HTTP

Preconditions:

- Doctor passes, browser is signed in, and `$RUN/evidence/inputs/verify-note.txt` exists. To prove both empty-state and toolbar entries, cancel the first dialog before uploading through the second.
- Image/PDF/Markdown preview cases require real input fixtures of those types; the baseline only includes text and HTML. Missing fixtures are a reported failure for those journeys.

- **Dialog and cancellation.** Record the empty listing, choose `Upload files`, select the text file using preview upload selector `input[type=file][multiple]`, and choose `Cancel`. The dialog disappears and the listing remains empty. Reopen using toolbar `Upload`.
- **Upload.** Select the text input again; expect `1 file selected`. Keep Public and no expiration. Start capture before choosing `Upload 1`. Wait for `Uploaded` and the link `Open verify-note.txt`. Save queue/listing snapshots and actions. Reload `/`; the same link must remain. Open it and capture `File preview`, `Details`, and `Versions` showing v1.
- **Stored bytes.** Run `"$CONTROL" http "$RUN" /api/files transfer-files`. Find the observed ID for `verify-note.txt`, read `/api/files/FILE_ID` into `transfer-detail`, and assert name, `sizeBytes`, visibility, and v1. Run `curl -fsS http://localhost:5174/f/FILE_ID -o "$RUN/evidence/download.txt"`, then `cmp "$RUN/evidence/inputs/verify-note.txt" "$RUN/evidence/download.txt"` and `sha256sum` both. Expect cmp exit 0 and equal hashes. Save command/status evidence. This checks persisted metadata and bytes in addition to the screen.
- **Drop/paste entries.** Repeat with distinct filenames via real OS/browser file drag or clipboard attachment; dashboard drops enqueue directly, dialog drops wait for `Upload N`. Also repeat toolbar opening with keyboard `u` outside fields. Capture each action and matching stored bytes separately. If the harness cannot supply real file drag/clipboard data, report SKIPPED with the limitation; selecting a file input does not prove these entries.
- **CLI.** Run `"$CONTROL" cli "$RUN" -- --json put "$RUN/evidence/inputs/verify-note.txt" --name cli-note.txt`; expect exit 0 and a file ID. Run `printf 'stdin orchid\n' | "$CONTROL" cli "$RUN" -- put - --name stdin-note.txt`. Retrieve an observed ID with `"$CONTROL" cli "$RUN" -- get FILE_ID --output "$RUN/evidence/cli-download.txt"`; compare source bytes. Repeat with `--output -` redirected to a file, recording diagnostics separately.
- **Private/HTML.** Upload the text through a fresh dialog with `Private` selected, then verify credential-less `/f/PRIVATE_ID` is 404 and the detail `Download` retrieves matching bytes via a temporary grant. Upload `site/index.html` as an ordinary file: the dialog must disable Private and explain HTML is always public. Open the public URL on port 5174 and observe rendered HTML. Authenticated API access on port 5174 and `/f/ID` on port 5173 must return 421.
- **Preview.** Upload real Markdown/image/PDF fixtures and reopen each from the listing; prove the actual preview rendered. For Markdown include an unsafe `javascript:` link and raw script, then inspect links and visible state for safe rendering.
- **DOCX preview.** Upload `apps/web/src/lib/dashboard/fixtures/preview.docx` through the file input with Private selected. Open its detail and verify the heading, paragraphs, list, and table. Reload and check again. Verify the authenticated `/api/files/FILE_ID/preview?v=1` returns the original bytes and anonymous access returns 401. Grid thumbnails must not fetch DOCX bytes. Repeat with a malformed `.docx`; expect an error, Try again, and Download. The preview omits images and Word pagination and accepts compressed documents up to 5 MiB.

## Gotchas

- Only the upload input has `[multiple]`; the version input is a separate file input on detail pages.
- The queue finishing is not persistence proof. Reload, read metadata independently, and compare the downloaded bytes.
- HTML is public even when uploaded with CLI `--private`. A private file's bare stable URL returning 404 is expected; its signed download URL must succeed.
- Content-origin responses/downloads are user paths. Download success does not prove orphan-free R2 storage; report direct enumeration separately when needed.
