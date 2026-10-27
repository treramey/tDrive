---
name: use-tdrive
description: Invoke whenever the user tells you to "use tdrive".
---

# Use tdrive

Use the installed `tdrive` CLI as the supported boundary for normal tdrive work. Prefer small operations and verify the results.

## Choose the executable

1. Use `tdrive` when it is installed, let the user know if it's not found and that they can install it from https://github.com/davis7dotsh/aDrive
2. Do not install, upgrade, log in, or replace credentials unless the user asked for it. If it's needed, tell the user and ask them if you can.

Use the selected form consistently in subsequent commands. The examples below use `tdrive`.

## Start with a preflight

Run:

```sh
tdrive whoami
```

- If a command will be parsed, pass `--json` and parse JSON rather than human-formatted columns.
- Never read, print, copy, or expose the config file or its API key.

If the environment blocks DNS or outbound access, distinguish that from a server failure and tell the user.

## Follow the everyday workflow

1. Inspect current state with `whoami`, `status`, or `list`.
2. Resolve file and tag IDs from fresh CLI output; do not rely on remembered IDs.
3. Confirm any material choice the user did not make, especially upload visibility, an overwrite destination, or an existing site to republish.
4. Run the narrowest command that completes the task.
5. Verify the result with `--json list`, `status`, a checksum, or the relevant tag/site response.
6. Report the concrete result or the literal error. Do not infer success from partial output.

## Inspect files

```sh
tdrive list
tdrive --json list
```

`list` follows pagination automatically. Use JSON mode to select a file by exact ID or display name. If multiple files have the same display name, show the candidates and ask which ID to use.

The CLI does not currently expose search, trash, restore, purge, visibility changes, or version-history commands. Do not silently bypass the CLI with raw authenticated API calls. Ask the user before expanding scope.

## Upload files

Uploads are **public by default**:

```sh
tdrive put "./report.pdf"
tdrive put "./private-notes.txt" --private
tdrive put "./report.pdf" --name "Quarterly report.pdf"
tdrive put "./report.pdf" --expires "2026-09-01T12:00:00Z"
```

For stdin, supply a display name:

```sh
some-command | tdrive put - --name "output.txt" --private
```

If the user doesn't say otherwise, it's fine to just make the file public. Make it private if the user asks for it.

Before uploading:

- Check `status` for the maximum upload size when the file may be large.
- Quote paths and display names.

After uploading, retain the returned file ID and verify its display name, size, content type, and visibility through `tdrive --json list`, then send that to the user.

## Download files

```sh
tdrive get <file-id>
tdrive get <file-id> --output "./destination.ext"
tdrive get <file-id> --output -
```

- Resolve the file ID from a fresh listing.
- Inspect an explicit destination before running the command; do not overwrite an existing local file without authorization.
- Let `tdrive get` handle private download grants internally. Never extract or expose signed URLs.
- Do not combine `--json` with `--output -` because stdout is carrying file bytes.
- For integrity-sensitive transfers, compare a checksum or byte size after download.

## Rename files

```sh
tdrive rename <file-id> "New display name.ext"
```

Resolve the ID first and verify the new display name in `tdrive --json list` afterward.

## Manage tags

```sh
tdrive tag list
tdrive tag create "project-name" --color '#2563eb'
tdrive tag update <tag-id> --name "new-name"
tdrive tag update <tag-id> --color '#7c3aed'
tdrive tag set <file-id> "project-name" "reference"
tdrive tag delete <tag-id>
```

- Colors require the quoted `#RRGGBB` form.
- `tag set` replaces the file's complete tag set. Inspect current tags and include every tag that should remain.
- Resolve tag and file IDs from fresh output before update or deletion.
- Verify changes with `tdrive --json tag list` and `tdrive --json list`.

## Publish static sites

Create a public site from a directory:

```sh
tdrive site put "./site-directory" --name "Site name"
```

Republish an existing site:

```sh
tdrive site put "./site-directory" --id <site-id>
```

- Site publishing is public.
- Inspect the directory first. The CLI rejects symlinks and non-regular assets.
- Use `--id` only after confirming the existing site ID; it updates that site.
- Verify the returned site ID, asset count, version, and public URL. A successful fetch may return a normal `2xx` response.

## Authenticate only when needed

```sh
tdrive login "https://drive.example.com"
tdrive login "https://drive.example.com" --headless --name "agent-cli"
```

- Login creates or replaces stored credential state. Do it only with user authorization.
- Prefer HTTPS. Use `--allow-http` only for an explicitly approved trusted private-network deployment.
- Never put a passcode, API key, session cookie, or approval token in a command argument or report.
- After login, run `tdrive whoami` and `tdrive status`.

## Check for updates

```sh
tdrive upgrade --check
tdrive update --check
```

`update` is an alias of `upgrade`. Run either only when the user asked to update the installed CLI. Verify the version afterward.

## Use JSON mode for automation

`--json` is accepted globally and may appear before the subcommand:

```sh
tdrive --json whoami
tdrive --json status
tdrive --json list
tdrive --json put "./file.txt" --private
```

- Parse stdout as JSON and check the process exit status.
- Expect rejected server requests in JSON mode to return a structured error and a nonzero exit.
- Keep file-byte stdout separate from JSON output.
- Do not scrape IDs from human-formatted output when JSON is available.

## Handle failures safely

- Preserve the exact user-facing error, HTTP status, and failed command without exposing credentials or signed URLs.
- Do not retry mutations blindly. Inspect whether the first attempt created or changed anything.
- For network failures, check DNS/connectivity and retry only after the environment issue is understood.
- For `401`, run `whoami`; do not immediately log in and overwrite credential state.
- For `403`, treat the credential as insufficient for that action rather than broken.
- For `413`, compare the file size with the upload limit from `status`.
- For `429`, honor the server's retry guidance instead of issuing a burst of retries.
