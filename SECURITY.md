# Security

vaultwarden-agent gives AI agents the use of credentials from a Bitwarden or Vaultwarden vault. What it protects
and what it can't is described in the [README](README.md#security).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/SkyliveLLC/vaultwarden-agent/security/advisories/new)
rather than in a public issue. Include steps to reproduce and the impact you see.

We'll acknowledge reports within 3 working days and keep you updated until a fix ships.
We're happy to credit you in the release notes.

## Scope

In scope: the CLI, the MCP server, and how they store the session key and pass secrets to commands. Especially
interesting:

- a secret value reaching the output of `search`, `status`, an MCP tool result, the audit log or an error message;
- `read` or `read_field` returning anything but a login's username from a profile that has reveal off;
- an item outside a profile's scope being found or resolved through the CLI or the MCP server;
- a secret of four or more characters that appears as-is in a command's output and isn't masked.

Out of scope: vulnerabilities in the `bw` CLI, Bitwarden or Vaultwarden themselves, and the limits the README
lists, such as an agent that encodes a secret before printing it or that reads the session key directly.
