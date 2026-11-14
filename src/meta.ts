import { readFileSync } from "node:fs";
import { z } from "zod";

export const PACKAGE_NAME = "@skylivellc/vaultwarden-agent";

/** The command people and agents type. */
export const BIN = "vaultwarden-agent";

/** Name the server registers under in MCP clients, so tools appear as `mcp__vault__*`. */
export const SERVER_NAME = "vault";

// src/ and dist/ sit at the same depth, so this resolves to the package root in both.
export const VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
