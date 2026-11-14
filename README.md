<img src="assets/icon.svg" width="64" height="64" alt="">

# vaultwarden-agent

Lets AI coding agents use the credentials in your [Bitwarden](https://bitwarden.com) or
[Vaultwarden](https://github.com/dani-garcia/vaultwarden) vault without reading them. It works with the
self-hosted servers you already run, so there is nothing to migrate.

An agent names a secret by reference and the tool hands the value to the command that needs it:

```sh
vaultwarden-agent run --env CLOUDFLARE_API_TOKEN=bw://work/Cloudflare/password -- wrangler deploy
```

`wrangler` gets the token in its environment. The agent sees wrangler's output with the token masked as
`[redacted:CLOUDFLARE_API_TOKEN]`. The value never enters the model's context, the transcript or the provider's logs.

```text
agent ── search_items (MCP) ──▶ names, usernames, field names. No values.
agent ── vaultwarden-agent run ──▶ bw CLI ──▶ your Bitwarden or Vaultwarden server
                │
                └─▶ your command, with the secret in its environment and masked in its output
```

It has two parts. A CLI does the work, and an MCP server lets Claude Code and Codex (and so
[T3 Code](https://t3.codes), which runs them) find items and learn the `run` command. Vault access goes through
the official [`bw` CLI](https://bitwarden.com/help/cli/), which is installed with this package, so this project
contains no vault cryptography.

Requires Node.js 22 or newer on Linux or macOS. CI runs the whole flow against Vaultwarden 1.37.

## Install and set up

```sh
git clone https://github.com/SkyliveLLC/vaultwarden-agent
cd vaultwarden-agent
corepack pnpm install   # installs the bw CLI and builds
npm link                # puts vaultwarden-agent on your PATH
vaultwarden-agent setup
```

Setup asks for:

1. A profile name, such as `work` or `personal`. Run setup once per vault. Each profile is a separate account
   on a separate server.
2. The server URL.
3. The account's personal API key, from **Settings → Security → Keys → View API key** in the web vault. It logs
   this machine in without a two-step prompt.
4. The master password, to unlock the vault. It is passed to `bw` and never stored.
5. Which folders and collections agents may use. Select none to allow the whole vault.
6. Whether agents may read secret values into the conversation. The default is no.

Then it adds the MCP server to Claude Code and Codex. Restart them and ask something like "deploy the worker
with my Cloudflare token from the vault".

## How agents use it

A reference is `bw://<profile>/<item>/<field>`:

- The item is its exact name or its ID. `search_items` returns ID-based references, which stay valid when two
  items share a name. Write a slash inside a name as `%2F`.
- The field is `username`, `password`, `totp` (the current one-time code), `uri`, `notes`, the name of a custom
  field, or a property of a card, identity or SSH key such as `privateKey`.

`run` takes any number of `--env NAME=<reference>` flags and the command after `--`. The command runs
directly, without a shell. For pipes or variable expansion, run a shell and refer to the variable inside it:

```sh
vaultwarden-agent run --env TOKEN=bw://work/GitHub/password -- \
  sh -c 'curl -sH "Authorization: Bearer $TOKEN" https://api.github.com/user'
```

The exit code is the command's. `run` goes through the agent's own shell tool, so the agent's permission rules
and sandbox apply to it like any other command.

The MCP server (registered as `vault`) has three tools, all read-only:

| Tool | What it does |
| --- | --- |
| `list_profiles` | The configured vaults, whether each is unlocked, and its scope and reveal settings. |
| `search_items` | Finds items by name, username or URI. Returns references and field names, never values. |
| `read_field` | Returns a username or URI. Returns a secret only if the profile has reveal on. |

Turn reveal on for a profile only when an agent must type a value itself, for example into a browser form
through computer use. Every other use works through `run`.

## Unlocking

The vault stays unlocked until you lock it or the machine reboots. When it is locked, agents get an error that
tells them to ask you:

```sh
vaultwarden-agent unlock work
```

In T3 Code the agent can ask for the master password with a `request_secret` card and pass it straight to
`unlock` through `BW_PASSWORD`, so the password never appears in the chat. `vaultwarden-agent lock` cuts
agents off immediately.

## Grok Bot

Grok Bot runs in xAI's cloud, so it gets no direct line to the vault. It uses your credentials through T3
Code instead. Add T3 Code's MCP server to Grok Bot as a custom connector (the URL is under **Settings →
Connections → Copy MCP URL** in T3 Code). Grok Bot can then start or message a T3 thread, and the agent in that
thread uses the vault on your machine. Secrets stay on the machine and Grok Bot only sees results. Tell Grok
Bot once:

```text
Remember: my credentials live in a vault that my T3 Code agents can use. When a task needs one of my
accounts, API tokens or logins, don't ask me for the secret. Send the task to a T3 thread and tell the
agent which vault item to use by name. It has the vault tools.
```

Grok Bot's own browser can't log in with vault passwords this way. That would mean sending the password to
xAI, which this tool doesn't do.

## CLI

```text
For agents
  run --env NAME=<reference> [--env ...] -- <command> [args]
  search [query]       Find items. Prints references and field names, never values
  read <reference>     Print a username or URI, or a secret if the profile allows reveal
  status               Show each profile and whether it is unlocked

For you
  setup                Log a vault in, choose what agents may use, and register the MCP server
  unlock [profile]     Unlock with your master password
  lock [profile]       Lock, so agents can't use the vault until you unlock it again
  logout <profile>     Log out and remove a profile, with its local vault cache
```

Setup runs without prompts when there is no terminal. It reads `BW_CLIENTID`, `BW_CLIENTSECRET` and
`BW_PASSWORD`, and takes the rest as flags:

```sh
vaultwarden-agent setup --profile work --server https://vault.example.com --scope Agents --client all --yes
```

Rerun setup for a profile to change its scope or reveal setting. To remove everything, run
`vaultwarden-agent logout <profile>` for each profile, then `claude mcp remove --scope user vault` and
`codex mcp remove vault`.

Each `bw` call takes about three seconds, so a `run` adds three to seven seconds before your command starts.
The vault is synced from the server when the local copy is more than five minutes old, and once more when a
referenced item isn't found.

## Security

What the tool does:

- `run` puts secrets in one command's environment and masks them in its output, so they stay out of the
  agent's context, the transcript and the model provider's logs.
- The master password is never stored. The session key that unlocking produces is kept in a file only you can
  read, on Linux in the tmpfs runtime directory (`/run/user/<uid>`), so a reboot locks every vault.
- A profile's scope limits agents to the folders and collections you chose, and reading secret values is off
  unless you turn reveal on.
- Every `run` and every secret read is appended to `~/.config/vaultwarden-agent/audit.log` with the time, the
  references and the command name. Values are never logged.
- Nothing secret is written to MCP client configs, which are often synced or shared.

What it can't do:

- Masking catches a secret that appears as-is in the output. It doesn't catch one that the command encodes,
  splits or writes to a file. The server's instructions tell agents not to do that, but an agent that follows a
  prompt injection could.
- Agents run as your operating system user, the same user that owns the session key. Scope and reveal are
  enforced by this tool, not by the operating system. An agent that goes around the tool, by reading the
  session key and calling `bw` itself, can read everything the vault account can.

So the boundary that holds against a misbehaving agent is the vault account. For credentials that matter,
create a separate vault account for agents, share one collection with it from an organization (Vaultwarden
includes organizations), and set this tool up with that account. Agents can then reach only what you shared,
whatever they do. This is the same shape as a 1Password service account.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm test:e2e` drives the built CLI and MCP server against a real Vaultwarden through the real `bw` CLI. Start
a disposable instance over HTTPS with signups enabled (the e2e job in [ci.yml](.github/workflows/ci.yml) has the
exact commands), then run:

```sh
NODE_EXTRA_CA_CERTS=/path/to/cert.pem VAULTWARDEN_E2E_URL=https://localhost:8443 pnpm test:e2e
```

The test registers its own account. `VAULTWARDEN_AGENT_DIR` moves the config, vault cache and session key to
another directory, which is how the tests stay away from your real profiles.

## License

[MIT](LICENSE) © Skylive LLC. The `bw` CLI it installs is Bitwarden's, under its own license.
