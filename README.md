# @mgcrea/mcp-npm

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-npm.svg)](https://www.npmjs.com/package/@mgcrea/mcp-npm)
[![ghcr](https://img.shields.io/badge/ghcr.io-mgcrea%2Fmcp--npm-blue)](https://github.com/mgcrea/mcp-npm/pkgs/container/mcp-npm)

A Model Context Protocol server for the npm registry, built around the thing npm's own
tooling makes hardest to automate: **configuring trusted publishers**. It also covers package
intel, dist-tags, deprecation, access, org and team governance, tokens, security advisories,
and publishing. Read-only by default — the mutating tools are not registered at all unless you
turn them on.

## Features

- **Trusted publishing, programmatically.** Read, set and revoke the OIDC trusted publisher on
  a package, or apply one across a batch of packages with a single browser authorization.
- **Works with zero configuration.** If `npm whoami` answers, so does this — it reads the token
  `npm login` already wrote to `~/.npmrc`, scoped to the registry you are actually talking to.
- **Read-only by default.** Write tools are _absent_, not refused, until `NPM_ALLOW_WRITES=1`.
  Everything irreversible additionally needs an explicit `confirm: true`.
- **Never exits on missing credentials.** An unconfigured server still answers, and
  `npm_auth_status` tells you exactly what to set.
- **Responses shaped for a context window.** A raw packument is megabytes; these are a screen.
- Native `fetch`, no runtime dependencies beyond the MCP SDK, Zod and `@mgcrea/mcp-totp`.

## Security

**Supply chain.** Three runtime dependencies: `@modelcontextprotocol/server`, `zod` and
`@mgcrea/mcp-totp`. No HTTP client, no logging framework. Every transitive dependency would be
attack surface on a process holding a live npm token.

The third is ours, and it is the fleet's usual justification for one: `@mgcrea/mcp-totp/core` is
the dependency-free half of our own TOTP server — RFC 6238, `otpauth://` parsing and the macOS
keychain store — and re-deriving it here would fork it on day one. It is imported **lazily**, so
a server in the default `web` mode never loads it, and it pulls in nothing of its own.

**Your credentials.** The token is read from `NPM_TOKEN`, a config file, or the entry in
`~/.npmrc` **matching the configured registry** — a token for npmjs.org is never sent to a
private registry, or the reverse. Nothing is written to disk. One-time passwords are held in
memory only, for the life of the process.

**Blast radius.** With the defaults, this server can only read. With `NPM_ALLOW_WRITES=1` it can
change what your CI is allowed to publish, move dist-tags, deprecate versions, alter org and team
membership, mint and revoke tokens, and publish or unpublish packages. Grant it deliberately.

**Token choice matters.** A granular access token with _Bypass 2FA_ enabled is rejected by every
trusted-publisher write. See [Traps worth knowing](#traps-worth-knowing).

## Configure

**The server starts with no configuration at all.** In that state it registers only the tools
that need none — `npm_auth_status` and `npm_audit_dependencies`, since npm's advisory endpoint
takes no authentication — and `npm_auth_status` tells you what to set for the rest. It never
refuses to start over a missing token, because an MCP server that exits shows up in the client
as a bare `Connection closed` with the explanation swallowed.

Most people need nothing:

```bash
npm login        # this server reads the resulting ~/.npmrc entry
npm whoami       # if this answers, you are configured
```

| Variable                | Required | Description                                                                                                  |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `NPM_TOKEN`             | no       | Overrides the `~/.npmrc` lookup. Needed in Docker and CI.                                                    |
| `NPM_REGISTRY`          | no       | Defaults to `https://registry.npmjs.org`. The `.npmrc` token is looked up for this host.                     |
| `NPM_DOWNLOADS_URL`     | no       | Defaults to `https://api.npmjs.org`. A different host, never authenticated.                                  |
| `NPM_ALLOW_WRITES`      | no       | `1` to register the write tools. Off by default.                                                             |
| `NPM_OTP_MODE`          | no       | `web` (default), `totp`, `static`, or `none`. See [Two-factor](#two-factor).                                 |
| `NPM_TOTP_LABEL`        | no       | `totp` mode: which seed to read. Defaults to `npm`.                                                          |
| `NPM_TOTP_SECRET`       | no       | `totp` mode: an `otpauth://` URI or base32 key, instead of the keychain.                                     |
| `NPM_OTP_AUTH_TYPE`     | no       | Overrides the `npm-auth-type` header. Escape hatch; leave unset.                                             |
| `NPM_OTP`               | no       | A code. Almost always wrong — see the note in `.env.example`.                                                |
| `NPM_OTP_TTL_SECONDS`   | no       | How long a confirmed code is reused. Defaults to `300`, npm's own window.                                    |
| `NPM_OTP_MAX_USES`      | no       | Calls one code covers. Defaults to `80`, npm's own guidance.                                                 |
| `NPM_AUTO_OPEN_BROWSER` | no       | `0` to print the URL instead of launching a browser.                                                         |
| `NPM_MAX_RETRIES`       | no       | Retry budget for 429/5xx. Defaults to `3`.                                                                   |
| `NPM_BIN`               | no       | Path to npm's `npm-cli.js` (or an npm executable), for `npm_publish`. Only needed when npm is not on `PATH`. |
| `NPM_MCP_CONFIG`        | no       | Path to a JSON config file.                                                                                  |
| `NPM_DEBUG`             | no       | `1` to log to stderr.                                                                                        |

See [.env.example](./.env.example) for the annotated list.

### Config file

- **The environment wins, field by field.** A config file supplies whatever the environment
  does not, so Docker and CI keep working, and a one-off `NPM_ALLOW_WRITES=0` still overrides a
  file that says `true`.
- Keys are camelCase (`allowWrites`, not `NPM_ALLOW_WRITES`).
- **Unknown keys are an error**, not ignored — a typo'd `allowWrite` tells you so instead of
  silently falling back to the environment.
- Location: `$NPM_MCP_CONFIG`, else `$XDG_CONFIG_HOME/npm-mcp/config.json`, else
  `~/.config/npm-mcp/config.json`. An absent file is fine; a malformed one is reported with its
  path. The variable is `NPM_MCP_CONFIG`, not `NPM_CONFIG`, because npm reads its own
  `npm_config_*` namespace out of the environment.
- The server warns on stderr if the file is readable by other users.

## Quick start

### A. npx

```json
{
  "mcpServers": {
    "npm": { "command": "npx", "args": ["-y", "@mgcrea/mcp-npm"] }
  }
}
```

### B. Docker

```bash
docker run --rm -i -e NPM_TOKEN ghcr.io/mgcrea/mcp-npm
```

### C. From source

```bash
pnpm install && pnpm build
node dist/cli.js
```

### Inspect the tools

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Two-factor

npm requires an `npm-otp` header on **all three** trusted-publisher endpoints — including the
read — and a one-time password lasts about five minutes. A code cannot be configured once at
startup and reused: it is dead before anything runs.

How far that gets you depends on `NPM_OTP_MODE`:

| Mode            | Where the code comes from                    | Unattended?                                            |
| --------------- | -------------------------------------------- | ------------------------------------------------------ |
| `web` (default) | npm's browser confirmation page              | No — one human click per five-minute window            |
| `totp`          | Minted locally from a stored seed            | **Yes**                                                |
| `static`        | `NPM_OTP`, typed in                          | No, and usually already expired by the time it is used |
| `none`          | Nothing; `npm_auth_otp` can still supply one | No                                                     |

`npm_auth_status` reports which flow will actually run, and says plainly what each one can and
cannot do rather than offering a setting that looks like it should work.

### `totp` mode

Set `NPM_OTP_MODE=totp` and the second factor is computed on the spot, with no browser and no
click, so batches and scripted publishes run start to finish on their own:

```bash
NPM_OTP_MODE=totp            # seed read via @mgcrea/mcp-totp
NPM_TOTP_LABEL=npm           # which seed; defaults to "npm"
NPM_TOTP_SECRET=...          # optional: otpauth:// URI or base32 key, for Docker/CI
```

With no `NPM_TOTP_SECRET`, the seed comes from the macOS login keychain — see
[`@mgcrea/mcp-totp`](https://github.com/mgcrea/mcp-totp) for how to get one in there, including
sharing it with Passwords.app so your phone keeps working.

**The trade is real and worth stating.** npm's second factor then lives on the same machine as
the npm token, so anything that can read that keychain item can publish as you. Where it applies,
**trusted publishing over OIDC is strictly better — it needs no second factor at all.** Reach for
`totp` for local publishes and account management, not as a substitute for OIDC in CI.

One implementation detail that matters if you are debugging it: a TOTP code is single-use, so the
provider never replays one npm has already consumed — if the current 30-second window is burnt it
waits for the next.

`npm-auth-type` stays `web` in this mode too. That was checked against the live registry rather
than assumed: a TOTP typed straight from an authenticator was accepted on both the publish and
trusted-publisher endpoints with `web` set, so npm validates `npm-otp` without consulting it —
and `web` is what makes npm attach an authorization URL to a challenge, which is the only way a
human recovers from a missing or wrong code. `NPM_OTP_AUTH_TYPE` overrides it if npm ever changes
how it negotiates.

In `web` mode, what _is_ possible is spending one authorization on many packages. npm's confirmation page has a
same-IP cooldown; this server caches the confirmed code for that window (in memory, never on
disk) so `npm_set_trusted_publisher_batch` prompts once for up to 25 packages.

The `web` flow, when npm asks:

1. A trust call goes out without a code and npm answers `401` with an authorization URL.
2. **Every trust tool except `npm_auth_otp` fails right there**, with that URL in `authUrl` and
   a `remedy` explaining the fix. None of them knows whether a human is watching this session, so
   none of them blocks waiting to find out — an immediate, actionable failure beats a multi-minute
   hang with nobody to click the link, which is what an earlier version of this server did.
3. `npm_auth_otp` is the one call that _does_ wait: run it first — with `code` from an
   authenticator app, or with `package` to open the browser and poll for up to `otpTimeoutMs`
   (180s default) — and every trust call after it rides the cached code until it expires.
   `npm_set_trusted_publisher_batch` does this too, once, on the first package only; the other 24
   ride the same cache, which is the whole mechanism behind its "one prompt" promise.

Reach for `npm_auth_otp` before any trust call in a non-interactive or agentic session — there is
no other way past step 2 there — or whenever you would rather approve the prompt at a moment of
your choosing. Pass it `code` to skip the browser entirely, or `open: false` when the browser is
on another machine.

## Tools

41 tools. **W** = needs `NPM_ALLOW_WRITES=1`; ⚠ = also needs `confirm: true`.

| Area               | Tools                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth               | `npm_auth_status`, `npm_auth_reload`, `npm_auth_otp`, `npm_auth_clear_otp`, `npm_whoami`                                                                                                                                                           |
| Trusted publishing | `npm_get_trusted_publisher`, `npm_set_trusted_publisher` **W**, `npm_set_trusted_publisher_batch` **W**, `npm_delete_trusted_publisher` **W**⚠                                                                                                     |
| Packages           | `npm_get_package`, `npm_get_package_version`, `npm_list_versions`, `npm_search_packages`                                                                                                                                                           |
| Dist-tags          | `npm_get_dist_tags`, `npm_add_dist_tag` **W**, `npm_remove_dist_tag` **W**⚠                                                                                                                                                                        |
| Downloads          | `npm_get_downloads`, `npm_get_version_downloads`                                                                                                                                                                                                   |
| Security           | `npm_audit_dependencies` _(no credentials needed)_                                                                                                                                                                                                 |
| Access             | `npm_get_package_visibility`, `npm_list_collaborators`, `npm_set_package_access` **W**⚠, `npm_deprecate_package` **W**⚠                                                                                                                            |
| Publishing         | `npm_publish` **W**⚠, `npm_unpublish` **W**⚠                                                                                                                                                                                                       |
| Orgs               | `npm_list_org_members`, `npm_list_org_teams`, `npm_list_org_packages`, `npm_set_org_member_role` **W**, `npm_remove_org_member` **W**⚠                                                                                                             |
| Teams              | `npm_list_team_members`, `npm_list_team_packages`, `npm_create_team` **W**, `npm_delete_team` **W**⚠, `npm_add_team_member` **W**, `npm_remove_team_member` **W**⚠, `npm_grant_team_package_access` **W**, `npm_revoke_team_package_access` **W**⚠ |
| Tokens             | `npm_list_tokens`, `npm_create_token` **W**, `npm_revoke_token` **W**⚠                                                                                                                                                                             |
| Escape hatch       | `npm_request`                                                                                                                                                                                                                                      |

## Worked example: trusted publishing across a fleet

The problem this server was written for. You have several packages published from one repo, and
npm's UI wants you to configure each by hand.

First, check you can:

```
npm_auth_status
```

`trusted_publishing_available` must be `true`. If it is not, `blockers` says why — the usual
answers are a `bypass_2fa` token or 2FA not enabled on the account itself.

See what one package has today:

```
npm_get_trusted_publisher  package="@mgcrea/mcp-ovh"
```

This is the call that triggers the browser confirmation, because npm requires an OTP even to
read. Approve it once.

Now preview the whole batch — nothing is written:

```
npm_set_trusted_publisher_batch
  packages=["@mgcrea/mcp-npm", "@mgcrea/mcp-ovh", "@mgcrea/mcp-x"]
  provider="github"
  repository="mgcrea/mcp-npm"
  workflow_filename="ci.yml"
  dry_run=true
  confirm=true
```

Then drop `dry_run`. Packages already configured correctly come back as `unchanged` and cost
nothing. Verify against npm's own CLI, which calls the same endpoint:

```bash
npm trust list @mgcrea/mcp-ovh
```

With that in place, CI publishes with no token anywhere:

```yaml
permissions:
  contents: read
  id-token: write   # this is what OIDC trusted publishing needs
# ...
- run: npm publish --provenance --access public
```

## Traps worth knowing

1. **A "Bypass 2FA" granular token is refused by every trust write** (403, pointing at
   `gh.io/npm-gat-bypass2fa-deprecation`). Reads keep working, so it only surfaces on the write.
   Create a token without that option, or use a session token from `npm login`.
2. **Two-factor must be on the npm _account_, not just the token.** No token setting substitutes.
3. **Several governance reads accept only a session token.** `npm_list_tokens`,
   `npm_list_org_members`, `npm_list_collaborators` and `npm_get_package_visibility` refuse a
   granular access token — so a _read_ can fail where the matching _write_ succeeds. This is the
   failure someone who followed npm's own "use granular tokens" advice will hit.
4. **One trusted publisher per package, and no update endpoint.** Changing one is genuinely
   delete-then-create. `npm_set_trusted_publisher` owns both steps for a reason: split apart, a
   failed create after a successful delete leaves the package with _no_ publisher and a broken
   release pipeline.
5. **`workflow_filename` is a bare filename.** `ci.yml`, never `.github/workflows/ci.yml`.
6. **Scoped names are escaped two different ways.** `/@babel%2fcore` for the packument,
   `%40babel%2Fcore` for the `/-/package/` routes. The wrong one returns 404, which reads like
   "no such package".
7. **Bulk downloads rejects scoped packages**, caps at 128, and cannot do a daily series. The
   single-package form handles `@scope/name` fine.
8. **Deprecating with an empty message *un*deprecates.**
9. **`npm_create_token` shows the value once.** It is never retrievable again, only revocable.
10. **`npm_publish` produces no provenance attestation.** A CI publish over OIDC does. Prefer it.
11. **npm publishes no rate-limit headers**, and documents no per-endpoint numbers — only that
    5M requests/month is acceptable. Assume nothing; the batch tool paces itself at 2s.
12. **A successful publish can 404 on the read path for several minutes** — `npm view`,
    `npm_get_package`, even `registry.npmjs.org` directly. Seen on an ordinary Nth publish, not
    only the first-publish case in npm-first-publish-bootstrap. The write already landed if the
    CLI printed `+ <pkg>@<version>` or, for a provenance publish, logged a transparency-log URL
    (`search.sigstore.dev/?logIndex=...`) — that log entry is independently verifiable and does
    not depend on npm's own read path at all. A stale read right after publishing is not
    evidence of failure; poll rather than conclude.

## Troubleshooting

**A tool I expected is missing.** Call `npm_auth_status`. An absent tool almost always means
missing configuration or `NPM_ALLOW_WRITES` being off — write tools are not registered at all
when it is unset, by design.

**Everything 401s, but `npm whoami` works in my terminal.** The token this server holds is a
stale copy. It reads `~/.npmrc` once at startup, so an `npm login` that visibly succeeded does
not reach a server that was already running. Call **`npm_auth_reload`** — it re-reads the token
and reports whether it changed. A 401 also triggers the same re-read automatically and retries
once, so this is mostly self-healing now; the tool is for confirming it, and for the case where
you would rather not spend a failed call finding out.

One thing a reload cannot fix: if the server started with **no** token at all, the credentialled
tools were never registered, and only a restart adds them.

**`Connection closed` in the client.** Run the binary by hand with the same environment; the
error the client swallowed is on stderr.

**Every trust call 403s.** Read the `remedy` field on the error. The three causes are a
`bypass_2fa` token, 2FA not enabled on the account, and not being a maintainer.

**The browser prompt keeps reappearing.** The cached code is being minted for a different npm
account than the token belongs to. `npm_auth_clear_otp`, then check `npm_auth_status` names the
account you expect.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

Check the built server still speaks the protocol and gates what it should:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm and GHCR from the tag
```

CI publishes over OIDC trusted publishing with provenance, so no npm token exists anywhere.

## License

MIT — see [LICENSE](./LICENSE).
