/**
 * Runs the official Bitwarden CLI (`bw`) for one profile. The CLI does the
 * login, sync and decryption, so this project never handles vault crypto. Each
 * profile gets its own bw data directory, which keeps several accounts on
 * several servers apart.
 */
import { execFile } from "node:child_process";
import { stat, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { profileDir, readIfExists, sessionPath, writePrivate } from "./config.js";
import { BIN } from "./meta.js";

const run = promisify(execFile);

/** The vault cache is refreshed from the server when the last attempt is older than this. */
const SYNC_MAX_AGE_MS = 5 * 60_000;

/** A sync that takes longer than this is abandoned, e.g. when the server is behind a VPN that is down. */
const SYNC_TIMEOUT_MS = 20_000;

export class BwError extends Error {
  override name = "BwError";
}

/** The profile has no valid session key. Only the user can fix that, with their master password. */
export class LockedError extends BwError {
  constructor(profile: string) {
    super(
      `The "${profile}" vault is locked. Ask the user to run \`${BIN} unlock ${profile}\` in a terminal. ` +
        "It needs their master password, which you must not ask for in chat.",
    );
  }
}

const text = z.string().nullish();
/** String-valued properties of a card, identity or SSH key. */
const section = z.record(z.string(), z.unknown()).nullish();

const Item = z.object({
  id: z.string(),
  name: z.string(),
  folderId: text,
  collectionIds: z.array(z.string()).nullish(),
  notes: text,
  fields: z.array(z.object({ name: text, value: text })).nullish(),
  login: z.object({ username: text, password: text, totp: text, uris: z.array(z.object({ uri: text })).nullish() }).nullish(),
  card: section,
  identity: section,
  sshKey: section,
});
export type Item = z.infer<typeof Item>;

const Named = z.object({ id: z.string(), name: z.string() });
const list = <T extends z.ZodType>(of: T) => z.object({ data: z.array(of) });
const Status = z.object({
  template: z.object({ status: z.enum(["unauthenticated", "locked", "unlocked"]), serverUrl: text, userEmail: text }),
});
const Response = z.union([
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({ success: z.literal(false), message: z.string() }),
]);

/** Path to the bw CLI that ships as this package's dependency, so its version is the one CI tested. */
function bwScript(): string {
  const manifest = createRequire(import.meta.url).resolve("@bitwarden/cli/package.json");
  return join(dirname(manifest), "build", "bw.js");
}

export type Bw = ReturnType<typeof createBw>;

export function createBw(profile: string) {
  const dataDir = profileDir(profile);
  const sessionFile = sessionPath(profile);
  const syncStamp = join(dataDir, "last-sync");

  /** Runs one bw command and returns the `data` of its JSON response. */
  async function bw(args: string[], env: Record<string, string> = {}, timeout?: number): Promise<unknown> {
    const session = (await readIfExists(sessionFile)) ?? "";
    const output = await run(process.execPath, [bwScript(), ...args, "--response", "--nointeraction"], {
      // An empty BW_SESSION makes bw report "locked" instead of inheriting a session from the caller's shell.
      env: { ...process.env, BW_SESSION: session, ...env, BITWARDENCLI_APPDATA_DIR: dataDir },
      maxBuffer: 256 * 1024 * 1024,
      timeout,
    }).catch((error: unknown) => {
      // bw exits non-zero on failure but still prints its JSON response.
      if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string") return { stdout: error.stdout };
      throw error;
    });
    // bw can print notices before the response, which is always the last line.
    const line = output.stdout.trim().split("\n").at(-1) ?? "";
    let response: z.infer<typeof Response>;
    try {
      response = Response.parse(JSON.parse(line));
    } catch {
      throw new BwError(`bw ${args[0]} returned no response.`);
    }
    if (response.success) return response.data;
    if (response.message === "Vault is locked.") throw new LockedError(profile);
    if (response.message === "You are not logged in.") {
      throw new BwError(`The "${profile}" profile is not logged in. Ask the user to run \`${BIN} setup\` in a terminal.`);
    }
    throw new BwError(response.message);
  }

  /** Pulls the vault from the server. The stamp records the attempt, so an unreachable server is retried every SYNC_MAX_AGE_MS, not on every call. */
  async function sync(): Promise<void> {
    await writePrivate(syncStamp, "");
    await bw(["sync"], {}, SYNC_TIMEOUT_MS);
  }

  return {
    /** Points the profile at a server. Only works while logged out. */
    async setServer(url: string): Promise<void> {
      await bw(["config", "server", url]);
    },

    async status() {
      return Status.parse(await bw(["status"])).template;
    },

    /** Logs in with the account's personal API key, which skips two-step login. bw keeps the resulting tokens. */
    async login(clientId: string, clientSecret: string): Promise<void> {
      await bw(["login", "--apikey"], { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret });
    },

    /** Unlocks with the master password and saves the session key. The password itself is never stored. */
    async unlock(password: string): Promise<void> {
      const data = await bw(["unlock", "--passwordenv", "BW_PASSWORD"], { BW_PASSWORD: password }).catch((error: unknown) => {
        if (error instanceof BwError && /decryption operation failed|invalid master password/i.test(error.message)) {
          throw new BwError("Wrong master password.");
        }
        throw error;
      });
      await writePrivate(sessionFile, z.object({ raw: z.string() }).parse(data).raw);
      // Unlocking works offline, so an unreachable server doesn't fail it.
      await sync().catch(() => undefined);
    },

    /** Locks the vault and deletes the session key. */
    async lock(): Promise<void> {
      await bw(["lock"]).catch(() => undefined);
      await rm(sessionFile, { force: true });
    },

    /** Logs out and deletes the profile's vault cache and session key. */
    async logout(): Promise<void> {
      await bw(["logout"]).catch(() => undefined);
      await rm(sessionFile, { force: true });
      await rm(dataDir, { recursive: true, force: true });
    },

    sync,

    /**
     * Syncs when the last attempt is older than SYNC_MAX_AGE_MS, so rotated secrets
     * show up on their own. If the sync fails or times out, the cache is used as
     * it is. A locked vault still fails on the next read.
     */
    async syncIfStale(): Promise<void> {
      const age = await stat(syncStamp).then(
        (stamp) => Date.now() - stamp.mtimeMs,
        () => Infinity,
      );
      if (age > SYNC_MAX_AGE_MS) await sync().catch(() => undefined);
    },

    /** Every item in the vault, decrypted. Items in the trash are left out by bw. */
    async items(): Promise<Item[]> {
      return list(Item).parse(await bw(["list", "items"])).data;
    },

    async folders() {
      return list(Named).parse(await bw(["list", "folders"])).data;
    },

    async collections() {
      return list(Named).parse(await bw(["list", "collections"])).data;
    },

    /** The current one-time code for an item that has an authenticator key. */
    async totp(itemId: string): Promise<string> {
      return z.object({ data: z.string() }).parse(await bw(["get", "totp", itemId])).data;
    },
  };
}
