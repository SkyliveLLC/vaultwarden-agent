import type { Bw, Item } from "../src/bw.js";
import type { Config } from "../src/config.js";
import { createVault, type VaultDeps } from "../src/vault.js";

type AuditEntry = Parameters<VaultDeps["audit"]>[0];

export const SECRET = "hunter2-cf-PASS";
export const TOKEN = "cf-SECRET-token-123";

/** A small vault: one item in the "Agents" folder, one in a collection, and two outside both. */
export const ITEMS: Item[] = [
  {
    id: "id-cloudflare",
    name: "Cloudflare",
    folderId: "folder-agents",
    notes: "deploy notes",
    fields: [{ name: "api token", value: TOKEN }],
    login: { username: "conan@example.com", password: SECRET, totp: "JBSWY3DPEHPK3PXP", uris: [{ uri: "https://dash.cloudflare.com" }] },
  },
  { id: "id-stripe", name: "Stripe", collectionIds: ["collection-deploy"], login: { username: "ops", password: "sk_live_stripe" } },
  { id: "id-bank", name: "Bank", login: { username: "me", password: "bank-pass-999" } },
  { id: "id-cloudflare-2", name: "Cloudflare", login: { username: "other", password: "other-pass" } },
];

/**
 * A stand-in for the bw CLI wrapper. `items` can be replaced between calls, and
 * `synced` counts forced syncs, to observe the sync-then-retry on a missing item.
 */
export function fakeBw(initial: Item[] = ITEMS) {
  const state = { items: initial, onSync: () => {}, synced: 0, locked: false };
  const sync = async () => {
    state.synced++;
    state.onSync();
  };
  const bw: Bw = {
    setServer: async () => {},
    status: async () => ({ status: state.locked ? "locked" : "unlocked", serverUrl: "https://vault.test", userEmail: "me@vault.test" }),
    login: async () => {},
    unlock: async () => {},
    lock: async () => {},
    logout: async () => {},
    sync,
    syncIfStale: async () => {},
    items: async () => {
      if (state.locked) throw new Error("locked");
      return state.items;
    },
    folders: async () => [
      { id: "folder-agents", name: "Agents" },
      { id: "", name: "No Folder" },
    ],
    collections: async () => [{ id: "collection-deploy", name: "Deploy" }],
    totp: async () => "123456",
  };
  return { bw, state };
}

/** A vault over fake bw clients, one per profile in `profiles`, recording audit entries. */
export function testVault(profiles: Config["profiles"], fakes: Record<string, ReturnType<typeof fakeBw>> = {}) {
  const audits: AuditEntry[] = [];
  const fake = (name: string) => (fakes[name] ??= fakeBw());
  const vault = createVault({
    loadConfig: async () => ({ profiles }),
    bw: (name) => fake(name).bw,
    audit: async (entry) => void audits.push(entry),
  });
  return { vault, audits, fake };
}
