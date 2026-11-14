/**
 * MCP clients the setup CLI can register the server with. Claude Code and Codex
 * are configured through their own `mcp` commands, so their config formats stay
 * theirs to own. T3 Code runs these same agents, so registering here covers it.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { BIN, SERVER_NAME } from "./meta.js";

const run = promisify(execFile);

/** Runs a client CLI from the home directory, so project-scoped entries in the current directory don't affect it. */
const exec = (file: string, args: string[]) => run(file, args, { cwd: homedir() });

const succeeds = (file: string, args: string[]) =>
  exec(file, args).then(
    () => true,
    () => false,
  );

export interface McpClient {
  id: "claude-code" | "codex";
  name: string;
  /** Whether the client is installed on this machine. */
  detect(): Promise<boolean>;
  isRegistered(): Promise<boolean>;
  /** Registers the stdio command that starts the server. */
  register(command: string[]): Promise<void>;
  unregister(): Promise<void>;
}

export const clients: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    detect: () => succeeds("claude", ["--version"]),
    // `get` also finds local and project entries, but setup only manages the user-scope one.
    isRegistered: () =>
      exec("claude", ["mcp", "get", SERVER_NAME]).then(
        ({ stdout }) => /Scope: User/.test(stdout),
        () => false,
      ),
    async register(command) {
      await exec("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...command]);
    },
    async unregister() {
      await exec("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    },
  },
  {
    id: "codex",
    name: "Codex",
    detect: () => succeeds("codex", ["--version"]),
    isRegistered: () => succeeds("codex", ["mcp", "get", SERVER_NAME]),
    async register(command) {
      await exec("codex", ["mcp", "add", SERVER_NAME, "--", ...command]);
    },
    async unregister() {
      await exec("codex", ["mcp", "remove", SERVER_NAME]);
    },
  },
];

/** The first PATH entry for `name` that is the same file as `target`, if any. */
function onPath(name: string, target: string, path: string = process.env.PATH ?? ""): string | undefined {
  const real = realpathSync(target);
  return path
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .find((candidate) => {
      try {
        return realpathSync(candidate) === real;
      } catch {
        return false;
      }
    });
}

/**
 * `node` by its PATH entry when there is one, because `process.execPath` can be
 * a versioned Homebrew path that an upgrade deletes.
 */
const nodePath = () => onPath("node", process.execPath) ?? process.execPath;

/** The stdio command MCP clients start the server with. Absolute, because clients don't always inherit a shell PATH. */
export const serverCommand = (script: string) => [nodePath(), script];

/** What an agent types in a shell to run this CLI: its name when installed on PATH, else node and the script path. */
export function shellCommand(script: string): string {
  if (onPath(BIN, script)) return BIN;
  return [nodePath(), script].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}
