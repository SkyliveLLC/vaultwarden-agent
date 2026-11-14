import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { SECRET, testVault } from "./helpers.js";

/** Connects an MCP client to the server over an in-memory transport. */
async function connect() {
  const { vault } = testVault({ work: { server: "https://vault.test" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(vault, "0.0.0-test", "node /opt/va/cli.js").connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content;
    return { isError: Boolean(result.isError), text: first?.type === "text" ? first.text : "" };
  }
  return { client, call };
}

describe("MCP server", () => {
  it("offers lookups only, and tells agents the run command of this installation", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["list_profiles", "search_items", "read_field"]);
    expect(client.getInstructions()).toContain("node /opt/va/cli.js run --env NAME=<reference>");
  });

  it("searches without leaking values", async () => {
    const { call } = await connect();
    const { text } = await call("search_items", { query: "cloudflare", profile: "work" });
    expect(text).toContain("bw://work/id-cloudflare");
    expect(text).not.toContain(SECRET);
  });

  it("reads a username, and answers a secret read with an error that points at run", async () => {
    const { call } = await connect();
    expect(await call("read_field", { ref: "bw://work/Bank/username" })).toEqual({ isError: false, text: '{"value":"me"}' });
    const refused = await call("read_field", { ref: "bw://work/Bank/password" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("run --env NAME=bw://work/Bank/password");
    expect(refused.text).not.toContain("bank-pass-999");
  });
});
