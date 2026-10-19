# Security notes

## Dependency audit (2026-10-19)

The locked dependencies clear all 38 findings from the production-only audit.
`bun audit --prod` reports no known vulnerabilities. The full `bun audit`
reports only the accepted low-severity `cookie` advisory below.

Run both commands when reviewing a release. A package declared as a development
dependency can still contribute code to the deployed Worker, as SvelteKit does.

Security updates:

- `agents@0.28.1` supplies compatible MCP peer requirements for client/server
  `2.3.1` and SDK `1.32.1`. Earlier Agents releases pin vulnerable MCP clients.
  Update the peer set together rather than overriding those requirements.
- `markdown-it@14.3.1` fixes the quadratic linkification paths used by Markdown
  previews. HTML remains disabled and unsafe link schemes remain rejected.
- `@sveltejs/kit@2.70.3` fixes the Accept-header denial of service without a
  SvelteKit major-version migration. Its shared serializer resolves to
  `devalue@5.9.4`.
- `wrangler@4.149.0` supplies Miniflare with `sharp@0.35.5` and
  `undici@7.29.1`. `concurrently@10.0.6` supplies `shell-quote@1.12.0`.
  These remove the additional native-image, HTTP-client, and command-injection
  findings from the full audit.
- Compatible transitive updates resolve `fast-uri@3.1.8`, `hono@4.13.13`,
  `ip-address@10.7.4`, `proxy-addr@2.0.8`, `qs@6.16.1`,
  `source-map-js@1.2.2`, and the CLI's `undici@8.12.3`.

No audit findings are suppressed. The lockfile records the patched versions;
install it with `bun install --frozen-lockfile`.

## Accepted dependency advisories

### `cookie@0.6.0`: GHSA-pxg6-pf52-xh8x (low)

- Path: `apps/web > @sveltejs/kit > cookie`
- The advisory concerns out-of-bounds characters in user-controlled cookie
  names, paths, or domains. a-drive sets exactly one cookie
  (`__Host-adrive-session`) with a fixed name and fixed attributes
  (`Path=/; HttpOnly; Secure; SameSite=Strict`), and never reflects user
  input into cookie attributes, so the vulnerable condition is not
  reachable.
- SvelteKit 2.70.3 still requires `cookie@^0.6.0`. A compatible transitive
  update cannot remove this finding. Do not force all cookie consumers onto
  another version or migrate to SvelteKit 3 solely to silence the audit.
- Action: pick up the transitive fix (`cookie >= 0.7.0`) with a compatible
  framework update. Recheck both the full and production-only audits during
  each release, and reassess this exception if cookie names or attributes
  become user-controlled.

Accepted: 2026-07-31. Revalidated: 2026-10-19.
