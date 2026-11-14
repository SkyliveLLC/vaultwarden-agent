import { describe, expect, it } from "vitest";
import { parseRef } from "../src/vault.js";
import { fakeBw, ITEMS, SECRET, testVault, TOKEN } from "./helpers.js";

const SERVER = { server: "https://vault.test" };

describe("parseRef", () => {
  it("decodes the item and field", () => {
    expect(parseRef("bw://work/AWS%2Fprod/api token")).toEqual({ profile: "work", item: "AWS/prod", field: "api token" });
  });

  it("rejects anything that isn't three parts", () => {
    for (const ref of ["GitHub/password", "bw://work/GitHub", "bw://work/a/b/c", "bw://work//password"]) {
      expect(() => parseRef(ref)).toThrow(/not a reference/);
    }
  });
});

describe("search", () => {
  it("returns references and field names but no secret values", async () => {
    const { vault } = testVault({ work: SERVER });
    const result = await vault.search("cloudflare");
    expect(result.items.map((item) => item.ref)).toEqual(["bw://work/id-cloudflare", "bw://work/id-cloudflare-2"]);
    expect(result.items[0]).toMatchObject({ username: "deploy@example.com", fields: ["api token", "username", "password", "uri", "notes", "totp"] });
    // Only a URI's scheme and host are shown. Connection strings and webhook URLs carry credentials in the rest.
    expect(result.items[0]?.uris).toEqual(["https://dash.cloudflare.com"]);
    const text = JSON.stringify(await vault.search(""));
    for (const secret of [SECRET, TOKEN, "deploy notes", "JBSWY3DPEHPK3PXP", "uri-pass", "uri-key", "db-pass"]) expect(text).not.toContain(secret);
  });

  it("matches only what it shows, so a query can't probe the hidden part of a URI", async () => {
    const { vault } = testVault({ work: SERVER });
    expect((await vault.search("dash.cloudflare")).items).toHaveLength(1);
    for (const hidden of ["uri-pass", "uri-key", "login", "nas-pass"]) expect((await vault.search(hidden)).items).toEqual([]);
  });

  it("shows only the host of a URI saved without a scheme", async () => {
    const { vault } = testVault({ work: SERVER });
    expect((await vault.search("NAS")).items[0]?.uris).toEqual(["nas.local:5000"]);
  });

  it("only sees items in the profile's scope, by folder or collection", async () => {
    const { vault } = testVault({ work: { ...SERVER, scope: ["Agents", "Deploy"] } });
    expect((await vault.search("")).items.map((item) => item.name)).toEqual(["Cloudflare", "Stripe"]);
  });

  it("fails on a scope name the vault doesn't have, so a typo can't pass as an empty vault", async () => {
    const { vault } = testVault({ work: { ...SERVER, scope: ["Agnets"] } });
    await expect(vault.search("", "work")).rejects.toThrow(/no folder or collection/);
  });

  it("reports a locked profile and still searches the others", async () => {
    const locked = fakeBw();
    locked.state.locked = true;
    const { vault } = testVault({ work: SERVER, personal: SERVER }, { personal: locked });
    const result = await vault.search("bank");
    expect(result.items.map((item) => item.ref)).toEqual(["bw://work/id-bank"]);
    expect(result.unavailable).toEqual([{ profile: "personal", reason: "locked" }]);
  });
});

describe("getProfile", () => {
  it("doesn't match names every object inherits", async () => {
    const { vault } = testVault({ work: SERVER });
    await expect(vault.read("bw://constructor/Bank/username")).rejects.toThrow(/No profile named "constructor"/);
  });
});

describe("resolveForRun", () => {
  it("resolves built-in, custom and totp fields, and audits references without values", async () => {
    const { vault, audits } = testVault({ work: SERVER });
    const refs = ["bw://work/id-cloudflare/password", "bw://work/id-cloudflare/api token", "bw://work/id-cloudflare/totp", "bw://work/Bank/username"];
    expect(await vault.resolveForRun(refs, "wrangler")).toEqual([SECRET, TOKEN, "123456", "me"]);
    expect(audits).toEqual([{ action: "run", refs, command: "wrangler" }]);
  });

  it("refuses an item outside the scope, by name and by ID", async () => {
    const { vault, audits } = testVault({ work: { ...SERVER, scope: ["Agents"] } });
    await expect(vault.resolveForRun(["bw://work/Bank/password"], "sh")).rejects.toThrow(/No item "Bank" in "work" within its scope/);
    await expect(vault.resolveForRun(["bw://work/id-bank/password"], "sh")).rejects.toThrow(/No item/);
    expect(audits).toEqual([]);
  });

  it("asks for an ID when a name is ambiguous", async () => {
    const { vault } = testVault({ work: SERVER });
    await expect(vault.resolveForRun(["bw://work/Cloudflare/password"], "sh")).rejects.toThrow(/id-cloudflare, id-cloudflare-2/);
  });

  it("names the available fields when one is missing", async () => {
    const { vault } = testVault({ work: SERVER });
    await expect(vault.resolveForRun(["bw://work/Bank/token"], "sh")).rejects.toThrow(/has no field "token". It has: username, password/);
  });

  it("syncs once and retries when an item is missing, to pick up one the user just added", async () => {
    const fake = fakeBw(ITEMS.slice(0, 1));
    fake.state.onSync = () => (fake.state.items = ITEMS);
    const { vault } = testVault({ work: SERVER }, { work: fake });
    expect(await vault.resolveForRun(["bw://work/Bank/password"], "sh")).toEqual(["bank-pass-999"]);
    await expect(vault.resolveForRun(["bw://work/Nope/password", "bw://work/Nada/password"], "sh")).rejects.toThrow(/No item "Nope"/);
    expect(fake.state.synced).toBe(2);
  });
});

describe("read", () => {
  it("returns a login's username without reveal", async () => {
    const { vault, audits } = testVault({ work: SERVER });
    expect(await vault.read("bw://work/Bank/username")).toBe("me");
    expect(audits).toEqual([]);
  });

  it("refuses every other field unless the profile allows reveal", async () => {
    const { vault } = testVault({ work: SERVER });
    for (const field of ["password", "totp", "uri", "notes", "api token"]) {
      await expect(vault.read(`bw://work/id-cloudflare/${field}`)).rejects.toThrow(/doesn't allow reading secrets/);
    }
  });

  it("doesn't treat a custom field named username as public, while run can still use it", async () => {
    const { vault } = testVault({ work: SERVER });
    for (const field of ["username", "uri"]) {
      await expect(vault.read(`bw://work/DB/${field}`)).rejects.toThrow(/doesn't allow reading secrets/);
    }
    expect(await vault.resolveForRun(["bw://work/DB/username"], "psql")).toEqual(["custom-user-secret"]);
  });

  it("returns a secret, and audits it, when reveal is on", async () => {
    const { vault, audits } = testVault({ work: { ...SERVER, reveal: true } });
    expect(await vault.read("bw://work/Bank/password")).toBe("bank-pass-999");
    expect(audits).toEqual([{ action: "read", refs: ["bw://work/Bank/password"] }]);
  });
});
