/**
 * `run`: starts a command with secrets in its environment and masks them in
 * its output. The agent chooses the command and sees the result, but the
 * secret values never pass through the agent's context.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { VaultError } from "./vault.js";

/** Shorter values would mask ordinary output, e.g. every "1" for a one-character field. */
const MIN_REDACT_LENGTH = 4;

/**
 * Returns a stream filter that replaces each secret with `[redacted:NAME]`.
 * A secret can be split across chunks, so the filter holds back any tail that
 * could be the start of one until the next chunk or `flush` settles it.
 * Text is handled as latin1 so arbitrary bytes pass through unchanged.
 */
export function createRedactor(secrets: Record<string, string>) {
  const targets = Object.entries(secrets)
    .map(([name, value]) => ({ value: Buffer.from(value, "utf8").toString("latin1"), mask: `[redacted:${name}]` }))
    .filter(({ value }) => value.length >= MIN_REDACT_LENGTH)
    // Longest first, so a secret that contains another is masked whole.
    .sort((a, b) => b.value.length - a.value.length);
  let pending = "";

  const mask = (text: string) => targets.reduce((result, { value, mask }) => result.replaceAll(value, mask), text);

  /** Length of the longest tail of `text` that is a proper prefix of a secret. */
  function heldLength(text: string): number {
    let held = 0;
    for (const { value } of targets) {
      for (let length = Math.min(value.length - 1, text.length); length > held; length--) {
        if (text.endsWith(value.slice(0, length))) held = length;
      }
    }
    return held;
  }

  return {
    write(chunk: Buffer): Buffer {
      const text = mask(pending + chunk.toString("latin1"));
      const held = heldLength(text);
      pending = text.slice(text.length - held);
      return Buffer.from(text.slice(0, text.length - held), "latin1");
    },
    flush(): Buffer {
      const rest = Buffer.from(pending, "latin1");
      pending = "";
      return rest;
    },
  };
}

/** Parses `--env NAME=bw://...` values into a name-to-reference map. */
export function parseEnvFlags(flags: string[]): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const flag of flags) {
    const split = flag.indexOf("=");
    const name = flag.slice(0, split);
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new VaultError(`"--env ${flag}" should look like --env NAME=bw://<profile>/<item>/<field>.`);
    }
    refs[name] = flag.slice(split + 1);
  }
  return refs;
}

/**
 * Runs a program with `secrets` added to the environment and resolves to its
 * exit code. stdin is passed through. stdout and stderr go through the redactor.
 */
export function runWithSecrets(file: string, args: string[], secrets: Record<string, string>): Promise<number> {
  const child = spawn(file, args, { env: { ...process.env, ...secrets }, stdio: ["inherit", "pipe", "pipe"] });
  for (const [source, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    const redactor = createRedactor(secrets);
    source.on("data", (chunk: Buffer) => sink.write(redactor.write(chunk)));
    source.on("end", () => sink.write(redactor.flush()));
  }

  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  return new Promise((resolve, reject) => {
    child.on("error", (error) => reject(new VaultError(`Could not start ${file}: ${error.message}`)));
    // "close" fires after both output streams have ended, so nothing is cut off.
    child.on("close", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
}
