/**
 * The saved profiles and where each profile's files live. A profile is one vault
 * account on one server, e.g. "work" on the company Bitwarden and "personal" on
 * a Vaultwarden. Nothing secret is stored here: the bw CLI keeps its own login
 * state in the profile's directory, and the unlock session key sits in a separate file.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BIN, errorMessage } from "./meta.js";

const Profile = z.strictObject({
  /** Server root, as returned by normalizeUrl. */
  server: z.string(),
  /** Folder and collection names. When set, the profile only exposes items inside them. */
  scope: z.array(z.string()).optional(),
  /** Lets `read` return secret fields to the agent. Off by default: secrets are only injected by `run`. */
  reveal: z.boolean().optional(),
});
export type Profile = z.infer<typeof Profile>;

const Config = z.strictObject({ profiles: z.record(z.string(), Profile) });
export type Config = z.infer<typeof Config>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Set to keep every file, the session key included, in one directory of your choosing. The tests use it. */
const DIR_OVERRIDE = "VAULTWARDEN_AGENT_DIR";

/**
 * Everything lives under the home directory on every platform, because MCP
 * clients start the server with a filtered environment (Codex passes an
 * allowlist), so variables like XDG_CONFIG_HOME can't be relied on.
 */
export const configDir = () => process.env[DIR_OVERRIDE] ?? join(homedir(), ".config", BIN);

export const configPath = () => join(configDir(), "config.json");

/** The bw CLI's data directory for a profile: its login state and encrypted vault cache. */
export const profileDir = (name: string) => join(configDir(), "profiles", name);

/**
 * Where a profile's session key is kept while the vault is unlocked. On Linux
 * that is the user's tmpfs runtime directory, so the key never reaches disk and
 * a reboot locks every vault. Elsewhere it falls back to the profile directory.
 */
export function sessionPath(name: string): string {
  const runtime = `/run/user/${process.getuid?.()}`;
  return !process.env[DIR_OVERRIDE] && existsSync(runtime) ? join(runtime, BIN, `${name}.session`) : join(profileDir(name), "session");
}

const isMissing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Reads a file as text, or returns undefined if it doesn't exist. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function loadConfig(): Promise<Config> {
  const path = configPath();
  const text = await readIfExists(path);
  if (text === undefined) return { profiles: {} };
  try {
    return Config.parse(JSON.parse(text));
  } catch (error) {
    throw new ConfigError(`${path} is not valid: ${errorMessage(error)}`);
  }
}

/** Writes a file readable by the current user only, replacing it in one step. */
export async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

export const saveConfig = (config: Config) => writePrivate(configPath(), `${JSON.stringify(config, null, 2)}\n`);

/** Looks a profile up by name, listing the configured ones when it's missing. */
export function getProfile(config: Config, name: string): Profile {
  // hasOwn, so names like "constructor" don't match what every object inherits.
  const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
  if (profile) return profile;
  const names = Object.keys(config.profiles);
  throw new ConfigError(
    names.length > 0
      ? `No profile named "${name}". Configured profiles: ${names.join(", ")}.`
      : `No vault is configured. Ask the user to run \`${BIN} setup\` in a terminal.`,
  );
}

/** Profile names appear in references and file paths, so they stay simple. */
export function checkProfileName(name: string): string {
  if (/^[a-z0-9][a-z0-9-]*$/.test(name)) return name;
  throw new ConfigError(`Profile name "${name}" must be lowercase letters, digits and dashes.`);
}

/** Accepts what people paste ("vault.example.com", "https://vault.example.com/") and returns the server root. */
export function normalizeUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ConfigError(`"${raw}" is not a valid URL.`);
  }
  // The bw CLI refuses anything else.
  if (url.protocol !== "https:") throw new ConfigError(`Use an https:// URL, not ${url.protocol}//`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
