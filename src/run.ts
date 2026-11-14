/**
 * `run`: starts a command with secrets in its environment and masks them in
 * its output. The agent chooses the command and sees the result, but the
 * secret values never pass through the agent's context.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { VaultError } from "./vault.js";

/** Shorter values, such as a card's three-digit code, are not masked: they would garble ordinary output. */
const MIN_REDACT_LENGTH = 4;

/**
 * Returns a stream filter that replaces each secret with `[redacted:NAME]`.
 * A secret can be split across chunks, so the filter holds back any tail that
 * could be the start of one until the next chunk or `flush` settles it. The
 * held text stays unmasked, so that a short secret inside a longer one can't
 * be masked first and break up the longer match.
 * Text is handled as latin1 so arbitrary bytes pass through unchanged.
 */
export function createRedactor(secrets: Record<string, string>) {
  const targets = Object.entries(secrets)
    .map(([name, value]) => ({ value: Buffer.from(value, "utf8").toString("latin1"), mask: `[redacted:${name}]` }))
    .filter(({ value }) => value.length >= MIN_REDACT_LENGTH)
    // Longest first, so a secret that contains another is masked whole.
    .sort((a, b) => b.value.length - a.value.length);
  let pending = "";

  /** Masks `text` up to `end`, and returns the masked part with the index where the unmasked rest begins. */
  function mask(text: string, end: number): { masked: string; rest: number } {
    let masked = "";
    let index = 0;
    while (index < end) {
      const target = targets.find(({ value }) => text.startsWith(value, index));
      // A secret that runs past `end` overlaps the held tail: hold all of it, so the next chunk can still extend it.
      if (target && index + target.value.length > end) break;
      masked += target ? target.mask : text[index];
      index += target ? target.value.length : 1;
    }
    return { masked, rest: index };
  }

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
      const text = pending + chunk.toString("latin1");
      const { masked, rest } = mask(text, text.length - heldLength(text));
      pending = text.slice(rest);
      return Buffer.from(masked, "latin1");
    },
    flush(): Buffer {
      const { masked } = mask(pending, pending.length);
      pending = "";
      return Buffer.from(masked, "latin1");
    },
  };
}

/** Parses `--env NAME=bw://...` values into a name-to-reference map. */
export function parseEnvFlags(flags: string[]): Record<string, string> {
  // fromEntries makes every name an own property, "__proto__" included.
  return Object.fromEntries(
    flags.map((flag) => {
      const split = flag.indexOf("=");
      const name = flag.slice(0, split);
      if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new VaultError(`"--env ${flag}" should look like --env NAME=bw://<profile>/<item>/<field>.`);
      }
      return [name, flag.slice(split + 1)];
    }),
  );
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
