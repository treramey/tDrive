# File lifecycle and versions

Users rename files, replace or restore their contents while retaining history, and recover or permanently delete trashed files.

## Sub-features

- `file-rename`: detail name editor and CLI rename.
- `file-versions`: upload, inspect, download, and restore historical versions.
- `file-trash`: detail/menu/bulk trash and restore.
- `file-purge`: single/bulk permanent deletion and empty trash.

## How to get to it (user POV)

- Open a file in the listing; choose its name (`title="Rename file"`), or run `bun tdrive rename ID NAME`.
- In detail choose `New version`; inspect `Versions`, row `Open`/`Download`, and older row `Restore`.
- Use detail `Move to trash`/`Restore file`, listing `Actions for NAME`, or checkboxes `Select NAME` and the bulk action bar.
- Choose `Trash`, then the row's `Delete permanently`, bulk deletion, or `Empty trash`.

## Driving it with browser/CLI/HTTP

Preconditions:

- Complete the transfer journey to create a normal text file and record its `FILE_ID`. Doctor passes and browser is signed in.
- Use additional uploaded files for destructive bulk/empty-trash entries so a prior deletion does not remove another journey's precondition.

- **Rename.** Open `verify-note.txt`, click the name button with title `Rename file`, replace textbox `File name` with `renamed-note.txt`, press Enter. Reload and confirm the name persists; `"$CONTROL" http "$RUN" /api/files/FILE_ID renamed-detail` agrees. Repeat through `"$CONTROL" cli "$RUN" -- --json rename FILE_ID cli-renamed.txt`; reload the browser and verify. Test Escape cancellation separately; expect no rename.
- **Versions.** Use preview upload on the file input labeled `New version` with `$RUN/evidence/inputs/replacement.txt`. Expect v2 Current plus v1. Download each using its row's `Open`/`Download` and compare v2 with replacement and v1 with original. Choose v1's `Restore`; reload and assert a new current version with original bytes, retaining the history. Read `/api/files/FILE_ID?versionsLimit=1` and follow `nextVersionsCursor` through `versionsCursor` to verify pagination; browser `Load older versions` needs more than the default 50 versions and must not be claimed from a two-version case.
- **Detail trash/restore.** Choose `Move to trash`; expect `In trash`. Return to `/`, confirm absence in Files, choose `Trash`, open the file, choose `Restore file`; confirm it returns to Files and content works.
- **Menu and bulk entries.** Use `Actions for cli-renamed.txt` > `Move to trash`, then Trash menu > `Restore`. Repeat through `Select NAME` checkboxes and bulk `Trash`/`Restore` buttons. Verify listing and `/api/files?trashed=true` after each transition, not only a toast.
- **Purge.** Trash a disposable file, then `Actions for NAME` > `Delete permanently`; confirm in dialog `Delete permanently?` using `Delete permanently`. It disappears from Trash and a later content GET returns 404. Repeat the bulk selection path with its confirmation dialog. Separately populate trash and use `Empty trash` > confirm `Empty trash`; read both Files and Trash to prove the intended files are gone. Wait for asynchronous purge completion before asserting a byte deletion.

## Gotchas

- Seed storage is empty; a missing uploaded corpus is a journey failure, not a reason to skip rename/version assertions.
- Restoring history creates a new version; it does not overwrite the old version. Inspect the resulting list and content.
- `Open` labels repeat in Share and version rows: scope to the intended row using fresh snapshots.
- Sites have audit versions but historical site content is not addressable. Use ordinary files for history downloads.
- Empty trash affects all scratch trash. Run only in the owned isolated runtime.
