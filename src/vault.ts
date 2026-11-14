/**
 * Finds items and resolves `bw://profile/item/field` references to values,
 * applying each profile's scope and reveal settings. Both the CLI and the MCP
 * server go through here, so the rules are the same for each.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bw, Item } from "./bw.js";
import { type Config, configDir, getProfile, type Profile } from "./config.js";
import { BIN, errorMessage } from "./meta.js";

export class VaultError extends Error {
  override name = "VaultError";
}

export interface Ref {
  profile: string;
  /** Item ID or exact item name. */
  item: string;
  field: string;
}

const SCHEME = "bw://";

/**
 * Parses `bw://profile/item/field`. Item and field are percent-decoded, so a
 * name containing a slash is written with %2F. Spaces can be written as they are.
 */
export function parseRef(ref: string): Ref {
  const parts = ref.startsWith(SCHEME) ? ref.slice(SCHEME.length).split("/") : [];
  const [profile, item, field] = parts;
  if (parts.length !== 3 || !profile || !item || !field) {
    throw new VaultError(`"${ref}" is not a reference. Use bw://<profile>/<item name or id>/<field>, e.g. bw://work/GitHub/password.`);
  }
  try {
    return { profile, item: decodeURIComponent(item), field: decodeURIComponent(field) };
  } catch {
    throw new VaultError(`"${ref}" has a malformed percent-escape.`);
  }
}

/**
 * The one value that identifies an account without granting access to it: a
 * login's own username. `read` returns it without `reveal`. A custom field or
 * identity property that is merely named `username` is not public.
 */
const PUBLIC_NAME = "username";
const isPublic = (item: Item, field: string) => field === PUBLIC_NAME && Boolean(item.login?.username);

const TOTP = "totp";

/**
 * An item's stored fields by name: custom fields, the properties of a card,
 * identity or SSH key (e.g. `privateKey`), then `username`, `password`, `uri`
 * and `notes`. A built-in name wins over a custom field of the same name.
 */
function storedFields(item: Item): Map<string, string> {
  const fields = new Map<string, string>();
  for (const { name, value } of item.fields ?? []) {
    if (name && value && !fields.has(name)) fields.set(name, value);
  }
  for (const section of [item.card, item.identity, item.sshKey]) {
    for (const [name, value] of Object.entries(section ?? {})) {
      if (typeof value === "string" && value) fields.set(name, value);
    }
  }
  const builtIn = {
    username: item.login?.username,
    password: item.login?.password,
    uri: item.login?.uris?.[0]?.uri,
    notes: item.notes,
  };
  for (const [name, value] of Object.entries(builtIn)) {
    if (value) fields.set(name, value);
  }
  return fields;
}

/**
 * The part of a URI that search shows and matches: scheme and host. Userinfo,
 * path and query are dropped, because connection strings and webhook URLs keep
 * credentials there. A password can itself contain `/`, `?` or `#`, so the host
 * is taken to start after the last `@` anywhere in the URI. A path containing
 * `@` then displays wrong, but no part of the userinfo can ever show.
 */
function displayUri(uri: string): string {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(uri)?.[0] ?? "";
  const afterUserinfo = uri.slice(Math.max(scheme.length, uri.lastIndexOf("@") + 1));
  const host = afterUserinfo.replace(/[/?#\s][\s\S]*$/, "");
  return host && scheme + host;
}

/** Field names an agent can reference on an item. `totp` is the current one-time code, computed on use. */
const fieldNames = (item: Item) => [...new Set([...storedFields(item).keys(), ...(item.login?.totp ? [TOTP] : [])])];

const displayUris = (item: Item) => item.login?.uris?.map(({ uri }) => displayUri(uri ?? "")).filter(Boolean) ?? [];

export interface ItemSummary {
  /** Reference prefix: append `/<field>`. */
  ref: string;
  name: string;
  username?: string;
  uris?: string[];
  fields: string[];
}

function summarize(profile: string, item: Item): ItemSummary {
  const uris = displayUris(item);
  return {
    ref: `${SCHEME}${profile}/${item.id}`,
    name: item.name,
    ...(item.login?.username && { username: item.login.username }),
    ...(uris.length > 0 && { uris }),
    fields: fieldNames(item),
  };
}

export interface VaultDeps {
  loadConfig: () => Promise<Config>;
  bw: (profile: string) => Bw;
  /** Records which references were used and by what. Never receives values. */
  audit: (entry: { action: "run" | "read"; refs: string[]; command?: string }) => Promise<void>;
}

const SEARCH_LIMIT = 50;

export type Vault = ReturnType<typeof createVault>;

export function createVault({ loadConfig, bw, audit }: VaultDeps) {
  /** A profile's items, limited to its scope. `fresh` forces a sync first. */
  async function loadItems(name: string, profile: Profile, fresh = false): Promise<Item[]> {
    const client = bw(name);
    // Best effort either way: with the server unreachable, the cache still answers.
    await (fresh ? client.sync().catch(() => undefined) : client.syncIfStale());
    if (!profile.scope?.length) return client.items();

    const [items, folders, collections] = await Promise.all([client.items(), client.folders(), client.collections()]);
    const containers = [...folders, ...collections];
    const unknown = profile.scope.filter((name) => !containers.some((container) => container.name === name));
    // A scope that matches nothing is more likely a typo than a wish to expose nothing, so say so.
    if (unknown.length > 0) {
      throw new VaultError(`Profile "${name}" is scoped to ${unknown.map((n) => `"${n}"`).join(", ")}, but the vault has no folder or collection with that name.`);
    }
    const allowed = new Set(containers.filter((container) => profile.scope?.includes(container.name)).map((container) => container.id));
    return items.filter((item) => [item.folderId, ...(item.collectionIds ?? [])].some((id) => id && allowed.has(id)));
  }

  function findItem(items: Item[], ref: Ref): Item | undefined {
    const byId = items.find((item) => item.id === ref.item);
    if (byId) return byId;
    const named = items.filter((item) => item.name === ref.item);
    if (named.length > 1) {
      throw new VaultError(
        `${named.length} items in "${ref.profile}" are named "${ref.item}". Reference one by ID: ${named.map((item) => item.id).join(", ")}.`,
      );
    }
    return named[0];
  }

  /** Resolves parsed references to their values and items, loading each profile's items once. */
  async function resolveRefs(refs: Ref[]): Promise<{ value: string; item: Item }[]> {
    const config = await loadConfig();
    const loaded = new Map<string, Promise<Item[]>>();
    const load = (name: string, fresh = false) => {
      const cached = fresh ? undefined : loaded.get(name);
      if (cached) return cached;
      const items = loadItems(name, getProfile(config, name), fresh);
      loaded.set(name, items);
      return items;
    };
    // Sequential, so a missing item triggers at most one extra sync per profile.
    const synced = new Set<string>();
    const resolved: { value: string; item: Item }[] = [];
    for (const ref of refs) {
      let item = findItem(await load(ref.profile), ref);
      // The user may have added the item moments ago: sync once before giving up.
      if (!item && !synced.has(ref.profile)) {
        synced.add(ref.profile);
        item = findItem(await load(ref.profile, true), ref);
      }
      if (!item) throw new VaultError(`No item "${ref.item}" in "${ref.profile}"${scopeNote(getProfile(config, ref.profile))}.`);

      const value = ref.field === TOTP && item.login?.totp ? await bw(ref.profile).totp(item.id) : storedFields(item).get(ref.field);
      if (value === undefined) {
        throw new VaultError(`"${item.name}" has no field "${ref.field}". It has: ${fieldNames(item).join(", ") || "no fields"}.`);
      }
      resolved.push({ value, item });
    }
    return resolved;
  }

  return {
    /** Each profile with its server, settings and whether it is unlocked. */
    async profiles() {
      const { profiles } = await loadConfig();
      return Promise.all(
        Object.entries(profiles).map(async ([name, profile]) => ({
          name,
          ...profile,
          status: await bw(name)
            .status()
            .then(({ status }) => status, errorMessage),
        })),
      );
    },

    /**
     * Finds items whose name, username or URI host contains `query`, in one
     * profile or all of them. Returns names, usernames, URI hosts and field names, never other values. A profile
     * that can't be searched (locked, unreachable) is reported, not fatal.
     */
    async search(query: string, only?: string) {
      const config = await loadConfig();
      const names = only ? [only] : Object.keys(config.profiles);
      if (names.length === 0) throw new VaultError(`No vault is configured. Ask the user to run \`${BIN} setup\` in a terminal.`);
      const needle = query.trim().toLowerCase();
      const items: ItemSummary[] = [];
      const unavailable: { profile: string; reason: string }[] = [];
      await Promise.all(
        names.map(async (name) => {
          try {
            for (const item of await loadItems(name, getProfile(config, name))) {
              // Match only what the result shows, so a query can't probe the hidden parts of a URI.
              const haystack = [item.name, item.login?.username, ...displayUris(item)];
              if (haystack.some((value) => value?.toLowerCase().includes(needle))) items.push(summarize(name, item));
            }
          } catch (error) {
            if (only) throw error;
            unavailable.push({ profile: name, reason: errorMessage(error) });
          }
        }),
      );
      items.sort((a, b) => a.name.localeCompare(b.name));
      return {
        items: items.slice(0, SEARCH_LIMIT),
        ...(items.length > SEARCH_LIMIT && { truncated: `${items.length} matches. Narrow the query to see the rest.` }),
        ...(unavailable.length > 0 && { unavailable }),
      };
    },

    /** Resolves references for `run`, which injects the values into a command and never prints them. */
    async resolveForRun(refs: string[], command: string): Promise<string[]> {
      const resolved = await resolveRefs(refs.map(parseRef));
      await audit({ action: "run", refs, command });
      return resolved.map(({ value }) => value);
    },

    /**
     * Returns one field's value to the caller, which for an agent means into
     * its context. A login's username is always readable. Anything else needs
     * the profile's `reveal` setting.
     */
    async read(ref: string): Promise<string> {
      const parsed = parseRef(ref);
      const profile = getProfile(await loadConfig(), parsed.profile);
      const refuse = () =>
        new VaultError(
          `"${parsed.field}" is a secret and the "${parsed.profile}" profile doesn't allow reading secrets. ` +
            `Use it without reading it: ${BIN} run --env NAME=${ref} -- <command>. ` +
            "Only the user can change that, by turning on reveal for the profile in setup.",
        );
      // Refuse before touching the vault, so a refused read costs no bw call and never asks for an unlock.
      if (!profile.reveal && parsed.field !== PUBLIC_NAME) throw refuse();
      const [resolved] = await resolveRefs([parsed]);
      // resolveRefs returns one entry per reference or throws. This narrows the type.
      if (!resolved) throw new VaultError(`Could not resolve ${ref}.`);
      if (isPublic(resolved.item, parsed.field)) return resolved.value;
      if (!profile.reveal) throw refuse();
      await audit({ action: "read", refs: [ref] });
      return resolved.value;
    },
  };
}

const scopeNote = (profile: Profile) => (profile.scope?.length ? ` within its scope (${profile.scope.join(", ")})` : "");

/** Appends to the audit log: one JSON line per use, with references and the command name but never a value. */
export function fileAudit(): VaultDeps["audit"] {
  return async (entry) => {
    const path = join(configDir(), "audit.log");
    await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  };
}
