#!/usr/bin/env node
/**
 * Entry point. With no command it serves MCP over stdio, which is how clients
 * launch it. Agents call `run`, `search` and `read` from a shell. The remaining
 * commands are for the person who owns the vault.
 */
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBw } from "./bw.js";
import { shellCommand } from "./clients.js";
import { loadConfig } from "./config.js";
import { BIN, errorMessage, VERSION } from "./meta.js";
import { parseEnvFlags, runWithSecrets } from "./run.js";
import { createServer } from "./server.js";
import { createVault, fileAudit } from "./vault.js";

const HELP = `${BIN} ${VERSION}: lets AI agents use Bitwarden and Vaultwarden credentials without reading them

For agents
  run --env NAME=bw://<profile>/<item>/<field> [--env ...] -- <command> [args]
                       Run a command with secrets in its environment, masked in its output
  search [query]       Find items. Prints references and field names, never values
  read <reference>     Print a login's username, or any other field if the profile allows reveal
  status               Show each profile and whether it is unlocked

For you
  setup                Log a vault in, choose what agents may use, and register the MCP server
  unlock [profile]     Unlock with your master password, from a prompt or BW_PASSWORD
  lock [profile]       Lock, so agents can't use the vault until you unlock it again
  logout <profile>     Log out and remove a profile
  serve                Run the MCP server over stdio (the default when an MCP client starts it)

Setup options
  --profile <name>     Profile to create or change
  --server <url>       Vault address, e.g. https://vault.example.com
  --scope <name>       Folder or collection agents are limited to (repeatable, "" for the whole vault)
  --reveal, --no-reveal
                       Whether \`read\` may return secret values
  --client <id>        claude-code, codex, all or none (repeatable)
  -y, --yes            Replace existing MCP registrations without asking

Without a terminal, setup reads BW_CLIENTID, BW_CLIENTSECRET and BW_PASSWORD.

Docs: https://github.com/SkyliveLLC/vaultwarden-agent`;

const vault = createVault({ loadConfig, bw: createBw, audit: fileAudit() });
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      env: { type: "string", multiple: true },
      profile: { type: "string" },
      server: { type: "string" },
      scope: { type: "string", multiple: true },
      reveal: { type: "boolean" },
      client: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) return console.log(VERSION);
  if (values.help || command === "help") return console.log(HELP);
  const single = (what: string) => {
    if (rest.length > 1) throw new Error(`Unexpected argument: ${rest.slice(1).join(" ")}`);
    return rest[0] ?? fail(`Give ${what}. Run ${BIN} --help.`);
  };

  switch (command) {
    case undefined:
      // A person ran it directly: explain instead of waiting silently for JSON-RPC.
      if (process.stdin.isTTY) return console.log(HELP);
      return serve();
    case "serve":
      return serve();
    case "run": {
      const refs = parseEnvFlags(values.env ?? []);
      const [program] = rest;
      if (!program) throw new Error("Give the command to run after `--`.");
      const resolved = await vault.resolveForRun(Object.values(refs), program);
      const secrets = Object.fromEntries(Object.keys(refs).map((name, i) => [name, resolved[i] ?? ""]));
      process.exitCode = await runWithSecrets(program, rest.slice(1), secrets);
      return;
    }
    case "search":
      return print(await vault.search(rest.join(" "), values.profile));
    case "read":
      return console.log(await vault.read(single("a reference")));
    case "status":
      return print(await vault.profiles());
    case "setup": {
      const { setup } = await import("./setup.js");
      return setup(
        { profile: values.profile, server: values.server, scope: values.scope, reveal: values.reveal, clients: values.client, yes: values.yes },
        import.meta.filename,
      );
    }
    case "unlock": {
      const { unlock } = await import("./setup.js");
      return unlock(rest.length > 0 ? single("a profile") : undefined);
    }
    case "lock": {
      const { lock } = await import("./setup.js");
      return lock(rest.length > 0 ? single("a profile") : undefined);
    }
    case "logout": {
      const { logout } = await import("./setup.js");
      return logout(single("a profile"));
    }
    default:
      throw new Error(`Unknown command "${command}". Run ${BIN} --help.`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function serve() {
  // stdout carries the protocol, so diagnostics go to stderr.
  serveStdio(() => createServer(vault, VERSION, shellCommand(import.meta.filename)), {
    onerror: (error) => console.error(`${BIN}: ${error.message}`),
  });
}

main().catch((error: unknown) => {
  console.error(`${BIN}: ${errorMessage(error)}`);
  process.exitCode = 1;
});
