# Search, browsing, and tags

Users find files by name or indexed text, change the listing layout and order, and organize/filter files with tags.

## Sub-features

- `browse-views`: Files/Trash, Grid/List, and sort.
- `search-query`: search box, keyboard focus, match/miss/clear.
- `tags-manage`: create, rename, recolor, delete.
- `tags-assign`: detail/upload/bulk assignment and filtering; CLI management.

## How to get to it (user POV)

- Use dashboard `Search files`, or press Command+K / Control+K to focus it.
- Choose `Grid view`, `List view`, or `Sort files`; choose Files/Trash.
- Choose `Edit tags`, a tag chip in `Filter tags`, or the detail `Tags` picker.
- Choose tags in the upload dialog or `Add tag to selected files` after selecting files.
- Run `bun adrive tag list|create|update|delete|set`.

## Driving it with browser/CLI/HTTP

Preconditions:

- Upload `verify-note.txt` containing `orchid budget` and a differently named/content file via real transfer paths. Record IDs; sign in and run doctor.
- Body search requires extraction/indexing to finish. If it never becomes searchable, record a failure with index state rather than substituting name-only coverage.

- **Browse.** Choose `List view` and `Grid view`; capture the same corpus in both. Select Sort files values `name`, `size`, and `updated` and verify actual order against recorded file metadata. Use differently sized/named files so the orders can be distinguished.
- **Search entries.** Fill `Search files` with `verify-note` via preview actions; wait for the result link. Clear it, focus outside fields, press `k` with Control (or Meta), and confirm search receives focus; type `orchid` and wait for the body match. Search `absentzz987654` and expect the no-results state. Clear the field and confirm the full listing returns. Read `"$CONTROL" http "$RUN" '/api/search?q=orchid' search-orchid` as independent result evidence. Repeat in Trash after trashing one corpus file; active/trash sets must differ correctly.
- **Manage tags.** Choose `Edit tags`; fill `New tag name` with `verify-reports`, choose `Create`. Confirm the tag appears after closing/reopening the manager and in `"$CONTROL" cli "$RUN" -- --json tag list`. Use the manager's `Rename verify-reports`, color control, and delete action; verify each persisted change with a second read.
- **Assign/filter.** Before deleting the tag, open a file's Tags picker (`Find or create a tag`), choose `verify-reports`, reload, and verify it remains selected. Return to the dashboard and click its chip in `Filter tags`; only tagged files remain. Choose `Clear`; the other file returns. Remove via its chip's `Remove verify-reports`. Repeat assignment through the upload dialog and the bulk `Add tag to selected files` entry, capturing each.
- **CLI.** Run `"$CONTROL" cli "$RUN" -- --json tag create verify-cli --color '#2563eb'`, record TAG_ID, then `"$CONTROL" cli "$RUN" -- --json tag set FILE_ID verify-cli`. Reload detail and filter to prove assignment. Run `tag update TAG_ID --name verify-cli-renamed`, verify, then `tag delete TAG_ID` and verify absence. Use the `cli RUN -- --json` prefix for each command.

## Gotchas

- There is no CLI search subcommand; use browser search and the public HTTP endpoint.
- Search is debounced and sorted by relevance; wait for results and do not assert normal sort order while a query is active.
- A tag picker may be hidden in upload until at least one tag exists. Create it first through the manager or CLI.
- Keyword/FTS/typo behavior is local; semantic search is disabled. A conceptual query cannot verify Vectorize here.
