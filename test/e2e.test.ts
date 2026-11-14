/**
 * End-to-end: the built CLI and its MCP server against a real Vaultwarden,
 * through the real bw CLI. Point VAULTWARDEN_E2E_URL at a disposable instance
 * with signups enabled (bw requires https, so set NODE_EXTRA_CA_CERTS for a
 * self-signed certificate). The test registers its own account. Run with `pnpm test:e2e`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAccount } from "./vaultwarden.js";

const url = process.env.VAULTWARDEN_E2E_URL?.replace(/\/+$/, "");
const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
const bwPath = join(dirname(createRequire(import.meta.url).resolve("@bitwarden/cli/package.json")), "build", "bw.js");

const PASSWORD = "e2e-item-password-Zx9";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!url)("against a real Vaultwarden", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const client = new Client({ name: "e2e", version: "0" });

  /** Runs a node script without a terminal and resolves with its output and exit code, even on failure. */
  function node(script: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [script, ...args], { env: { ...env, ...extraEnv } }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }
  const cli = (args: string[], extraEnv?: NodeJS.ProcessEnv) => node(cliPath, args, extraEnv);

  /** Adds an object to the vault with bw itself, as the user would from another client. */
  async function create(kind: "folder" | "item", value: Record<string, unknown>): Promise<string> {
    const session = await readFile(join(dir, "profiles", "e2e", "session"), "utf8");
    const { stdout, stderr } = await node(bwPath, ["create", kind, Buffer.from(JSON.stringify(value)).toString("base64"), "--raw"], {
      BITWARDENCLI_APPDATA_DIR: join(dir, "profiles", "e2e"),
      BW_SESSION: session,
    });
    const id: unknown = JSON.parse(stdout || `{"error":${JSON.stringify(stderr)}}`).id;
    if (typeof id !== "string") throw new Error(`bw create ${kind} failed: ${stdout}${stderr}`);
    return id;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content;
    return { isError: Boolean(result.isError), text: first?.type === "text" ? first.text : "" };
  }

  beforeAll(async () => {
    const account = await registerAccount(url ?? "");
    dir = await mkdtemp(join(tmpdir(), "vaultwarden-agent-e2e-"));
    env = { ...process.env, VAULTWARDEN_AGENT_DIR: dir };

    const first = await cli(["setup", "--profile", "e2e", "--server", url ?? "", "--client", "none"], {
      BW_CLIENTID: account.clientId,
      BW_CLIENTSECRET: account.clientSecret,
      BW_PASSWORD: account.password,
    });
    expect(first, first.stderr).toMatchObject({ code: 0 });

    const folderId = await create("folder", { name: "Agents" });
    const login = { username: "deploy@example.com", password: PASSWORD, uris: [{ uri: "https://deploy.example.com" }] };
    await create("item", { type: 1, name: "Deploy", folderId, login, fields: [{ type: 1, name: "api token", value: "tok_e2e_12345" }] });
    await create("item", { type: 1, name: "Bank", login: { username: "me", password: "bank-password-1" } });

    // Setup again, already logged in and unlocked, needs no credentials to change the scope.
    const scoped = await cli(["setup", "--profile", "e2e", "--scope", "Agents", "--client", "none"]);
    expect(scoped, scoped.stderr).toMatchObject({ code: 0 });

    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath], env: { ...env } as Record<string, string> }));
  }, 180_000);

  afterAll(async () => {
    await client.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("runs a command with the secret in its environment and masked in its output", async () => {
    const script = 'printf "%s" "$PW" | sha256sum; echo "password=$PW token=$TOKEN"; echo "stderr $PW" >&2; exit 3';
    const result = await cli(["run", "--env", "PW=bw://e2e/Deploy/password", "--env", "TOKEN=bw://e2e/Deploy/api token", "--", "sh", "-c", script]);
    expect(result.code).toBe(3);
    // The hash proves the command got the real value. The text proves the caller never sees it.
    expect(result.stdout).toContain(sha256(PASSWORD));
    expect(result.stdout).toContain("password=[redacted:PW] token=[redacted:TOKEN]");
    expect(result.stderr).toBe("stderr [redacted:PW]\n");
    expect(await readFile(join(dir, "audit.log"), "utf8")).toContain('"refs":["bw://e2e/Deploy/password","bw://e2e/Deploy/api token"],"command":"sh"');
  }, 60_000);

  it("refuses an item outside the profile's scope and a secret read", async () => {
    const outside = await cli(["run", "--env", "PW=bw://e2e/Bank/password", "--", "sh", "-c", 'echo "ran $PW"']);
    expect(outside).toMatchObject({ code: 1, stdout: "" });
    expect(outside.stderr).toContain('No item "Bank" in "e2e" within its scope (Agents)');

    const read = await cli(["read", "bw://e2e/Deploy/password"]);
    expect(read).toMatchObject({ code: 1, stdout: "" });
    expect((await cli(["read", "bw://e2e/Deploy/username"])).stdout).toBe("deploy@example.com\n");
  }, 60_000);

  it("serves lookups over MCP without secret values", async () => {
    const search = await callTool("search_items", { query: "" });
    expect(JSON.parse(search.text).items).toMatchObject([{ name: "Deploy", username: "deploy@example.com", fields: ["api token", "username", "password", "uri"] }]);
    expect(search.text).not.toContain(PASSWORD);

    expect(await callTool("list_profiles", {})).toMatchObject({ text: expect.stringContaining('"status":"unlocked"') });
    expect(await callTool("read_field", { ref: "bw://e2e/Deploy/password" })).toMatchObject({ isError: true });
  }, 60_000);

  it("stops serving secrets once the vault is locked", async () => {
    expect(await cli(["lock", "e2e"])).toMatchObject({ code: 0 });
    const result = await cli(["run", "--env", "PW=bw://e2e/Deploy/password", "--", "sh", "-c", 'echo "ran $PW"']);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("vault is locked");
  }, 60_000);
});
