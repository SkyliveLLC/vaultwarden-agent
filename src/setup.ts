/** The commands a person runs in a terminal: setup, unlock, lock and logout. */
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { type Bw, createBw } from "./bw.js";
import { clients, type McpClient, serverCommand } from "./clients.js";
import { checkProfileName, configDir, getProfile, loadConfig, normalizeUrl, type Profile, saveConfig } from "./config.js";
import { BIN, errorMessage, SERVER_NAME } from "./meta.js";

export interface SetupOptions {
  profile?: string | undefined;
  server?: string | undefined;
  /** Folder and collection names to expose. An empty string clears the scope. */
  scope?: string[] | undefined;
  reveal?: boolean | undefined;
  /** Client IDs, or "all" / "none". Defaults to every detected client. */
  clients?: string[] | undefined;
  /** Replace existing registrations without asking. */
  yes?: boolean | undefined;
}

/** A usage error: reported as-is and never retried. */
export class CliError extends Error {}

/** Unwraps a clack answer, exiting cleanly on Ctrl-C. */
async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
  // isCancel narrows the value but not the generic, so restate the narrowing.
  return value as Exclude<T, symbol>;
}

function fail(message: string): never {
  throw new CliError(message);
}

const tilde = (path: string) => path.replace(homedir(), "~");
const required = (label: string) => (value: string | undefined) => (value?.trim() ? undefined : `Enter ${label}.`);

/** Runs `attempt` until it succeeds, re-prompting only when a person is there to answer. */
async function untilValid<T>(interactive: boolean, attempt: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!interactive || error instanceof CliError) throw error;
      p.log.error(errorMessage(error));
    }
  }
}

/**
 * Unlocks one profile with the master password from a prompt, or from
 * BW_PASSWORD when there is no terminal. The password goes to bw and is not stored.
 */
async function unlockProfile(bw: Bw, name: string, interactive: boolean): Promise<void> {
  await untilValid(interactive, async () => {
    const password = interactive
      ? await ask(p.password({ message: `Master password for "${name}"`, validate: required("the master password") }))
      : process.env.BW_PASSWORD;
    if (!password) throw new CliError("Set BW_PASSWORD when running without a terminal.");
    await bw.unlock(password);
  });
}

export async function setup(options: SetupOptions, script: string): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);
  const validClients = [...clients.map((client) => client.id), "all", "none"];
  const unknown = options.clients?.filter((id) => !validClients.includes(id)) ?? [];
  if (unknown.length > 0) throw new CliError(`Unknown client ${unknown.join(", ")}. Use ${validClients.join(", ")}.`);

  const config = await loadConfig();
  p.intro("vaultwarden-agent setup");

  const name = checkProfileName(
    options.profile ??
      (interactive
        ? await ask(
            p.text({
              message: 'Profile name, e.g. "work" or "personal". Agents use it in references like bw://work/GitHub/password',
              initialValue: Object.keys(config.profiles)[0] ?? "personal",
              validate: (value) => {
                try {
                  checkProfileName(value ?? "");
                } catch (error) {
                  return errorMessage(error);
                }
              },
            }),
          )
        : fail("Pass --profile when running without a terminal.")),
  );
  const saved = config.profiles[name];
  const bw = createBw(name);

  const server = normalizeUrl(
    options.server ??
      (interactive
        ? await ask(
            p.text({
              message: "Bitwarden or Vaultwarden URL",
              placeholder: "https://vault.example.com",
              initialValue: saved?.server ?? "",
              validate: required("the address you open your vault at"),
            }),
          )
        : (saved?.server ?? fail("Pass --server when running without a terminal."))),
  );

  let { status, userEmail } = await bw.status();
  if (status !== "unauthenticated" && saved?.server !== server) {
    // A different server means a different account: start the profile over.
    await bw.logout();
    status = "unauthenticated";
  }
  if (status === "unauthenticated") {
    await bw.setServer(server);
    if (interactive) {
      p.note(
        `Open ${server}/#/settings/security/security-keys and choose "View API key".\nThe key logs this machine in. Reading the vault still needs your master password.`,
        "Personal API key",
      );
    }
    await untilValid(interactive, async () => {
      const clientId = interactive
        ? await ask(p.text({ message: "client_id", validate: required("the client_id") }))
        : process.env.BW_CLIENTID;
      const clientSecret = interactive
        ? await ask(p.password({ message: "client_secret", validate: required("the client_secret") }))
        : process.env.BW_CLIENTSECRET;
      if (!clientId || !clientSecret) throw new CliError("Set BW_CLIENTID and BW_CLIENTSECRET when running without a terminal.");
      await bw.login(clientId.trim(), clientSecret.trim());
    });
    ({ status, userEmail } = await bw.status());
  }
  p.log.success(`Logged in to ${server} as ${userEmail}`);

  if (status !== "unlocked") await unlockProfile(bw, name, interactive);
  p.log.success("Vault unlocked");

  const profile: Profile = { server };
  const scope = await chooseScope(bw, options.scope, saved?.scope, interactive);
  if (scope.length > 0) profile.scope = scope;
  const reveal =
    options.reveal ??
    (interactive
      ? await ask(
          p.confirm({
            message: "Let agents read secret values into the conversation? No keeps secrets usable only through `run`.",
            initialValue: saved?.reveal ?? false,
          }),
        )
      : saved?.reveal);
  if (reveal) profile.reveal = true;

  // Reload, so a setup of another profile that finished meanwhile isn't overwritten.
  const latest = await loadConfig();
  await saveConfig({ profiles: { ...latest.profiles, [name]: profile } });
  p.log.success(
    `Saved profile "${name}" to ${tilde(configDir())}: ${scope.length > 0 ? `scope ${scope.join(", ")}` : "whole vault"}, reveal ${reveal ? "on" : "off"}`,
  );

  const command = serverCommand(script);
  const added: string[] = [];
  for (const client of await chooseClients(options.clients, interactive)) {
    if (await registerWith(client, command, { interactive, yes: Boolean(options.yes) })) added.push(client.name);
  }
  p.outro(
    added.length > 0
      ? `Restart ${new Intl.ListFormat("en").format(added)} to load the vault tools.`
      : `Setup finished. To add the server to another MCP client, have it run: ${command.join(" ")}`,
  );
}

/** Picks the folders and collections the profile exposes. None means the whole vault. */
async function chooseScope(bw: Bw, requested: string[] | undefined, saved: string[] = [], interactive: boolean): Promise<string[]> {
  if (requested) return requested.filter(Boolean);
  if (!interactive) return saved;
  const [folders, collections] = await Promise.all([bw.folders(), bw.collections()]);
  // bw lists "No Folder" with an empty ID.
  const names = [...new Set([...folders, ...collections].filter(({ id }) => id).map(({ name }) => name))];
  if (names.length === 0) {
    p.log.info("The vault has no folders or collections, so agents can use every item. Add a folder and rerun setup to limit them.");
    return [];
  }
  return ask(
    p.multiselect({
      message: "Limit agents to these folders and collections (select none for the whole vault)",
      options: names.map((value) => ({ value })),
      initialValues: saved.filter((value) => names.includes(value)),
      required: false,
    }),
  );
}

async function chooseClients(requested: string[] | undefined, interactive: boolean): Promise<McpClient[]> {
  const detected = await Promise.all(clients.map((client) => client.detect()));
  const installed = clients.filter((_, i) => detected[i]);
  if (requested) {
    if (requested.includes("none")) return [];
    return requested.includes("all") ? installed : clients.filter((client) => requested.includes(client.id));
  }
  if (installed.length === 0 || !interactive) return installed;
  const ids = await ask(
    p.multiselect({
      message: "Add the MCP server to",
      options: installed.map((client) => ({ value: client.id, label: client.name })),
      initialValues: installed.map((client) => client.id),
      required: false,
    }),
  );
  return installed.filter((client) => ids.includes(client.id));
}

async function registerWith(
  client: McpClient,
  command: string[],
  { interactive, yes }: { interactive: boolean; yes: boolean },
): Promise<boolean> {
  try {
    if (await client.isRegistered()) {
      const replace =
        yes || (interactive && (await ask(p.confirm({ message: `${client.name} already has a "${SERVER_NAME}" server. Replace it?` }))));
      if (!replace) {
        p.log.warn(`Left ${client.name}'s existing "${SERVER_NAME}" server as it was${interactive ? "" : " (pass --yes to replace it)"}.`);
        return false;
      }
      await client.unregister();
    }
    await client.register(command);
    p.log.success(`Added to ${client.name}`);
    return true;
  } catch (error) {
    // A failed client CLI explains itself on stderr.
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    p.log.error(`Couldn't configure ${client.name}: ${stderr || errorMessage(error)}`);
    return false;
  }
}

/** Unlocks the named profile, or every locked one. */
export async function unlock(only: string | undefined): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY);
  const config = await loadConfig();
  if (only) getProfile(config, only);
  const names = only ? [only] : Object.keys(config.profiles);
  if (names.length === 0) throw new CliError(`No vault is configured. Run \`${BIN} setup\` first.`);
  if (!interactive && names.length > 1) throw new CliError("Name the profile to unlock when running without a terminal.");

  for (const name of names) {
    const bw = createBw(name);
    const { status } = await bw.status();
    if (status === "unauthenticated") throw new CliError(`"${name}" is not logged in. Run \`${BIN} setup --profile ${name}\`.`);
    if (status === "unlocked") {
      console.log(`${name}: already unlocked`);
      continue;
    }
    await unlockProfile(bw, name, interactive);
    console.log(`${name}: unlocked`);
  }
}

/** Locks the named profile, or all of them. Agents can't use a locked vault. */
export async function lock(only: string | undefined): Promise<void> {
  const config = await loadConfig();
  if (only) getProfile(config, only);
  for (const name of only ? [only] : Object.keys(config.profiles)) {
    await createBw(name).lock();
    console.log(`${name}: locked`);
  }
}

/** Logs a profile out and removes it, along with its vault cache. */
export async function logout(name: string): Promise<void> {
  const config = await loadConfig();
  getProfile(config, name);
  await createBw(name).logout();
  const { [name]: _, ...profiles } = config.profiles;
  await saveConfig({ profiles });
  console.log(`${name}: logged out and removed`);
}
