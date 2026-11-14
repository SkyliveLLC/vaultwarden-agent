import { describe, expect, it } from "vitest";
import { createRedactor, parseEnvFlags } from "../src/run.js";

/** Feeds chunks through a redactor and returns everything it emitted. */
function redact(secrets: Record<string, string>, chunks: string[]): string {
  const redactor = createRedactor(secrets);
  return Buffer.concat([...chunks.map((chunk) => redactor.write(Buffer.from(chunk))), redactor.flush()]).toString();
}

describe("createRedactor", () => {
  it("masks every occurrence of a secret", () => {
    expect(redact({ TOKEN: "s3cret-value" }, ["a s3cret-value b s3cret-value\n"])).toBe("a [redacted:TOKEN] b [redacted:TOKEN]\n");
  });

  it("masks a secret split across chunks, at every split point", () => {
    const text = "token=s3cret-value;";
    for (let split = 1; split < text.length; split++) {
      expect(redact({ TOKEN: "s3cret-value" }, [text.slice(0, split), text.slice(split)])).toBe("token=[redacted:TOKEN];");
    }
  });

  it("emits a held tail that turns out not to be a secret", () => {
    expect(redact({ TOKEN: "s3cret-value" }, ["prefix s3cr", "ipt done"])).toBe("prefix s3cript done");
    expect(redact({ TOKEN: "s3cret-value" }, ["ends with s3cret-val"])).toBe("ends with s3cret-val");
  });

  it("masks the longer secret when one contains another, at every split point", () => {
    const secrets = { USER: "deploy", URL: "postgres://deploy:hunter2@db" };
    const text = "deploy uses postgres://deploy:hunter2@db as deploy";
    for (let split = 0; split <= text.length; split++) {
      expect(redact(secrets, [text.slice(0, split), text.slice(split)])).toBe("[redacted:USER] uses [redacted:URL] as [redacted:USER]");
    }
  });

  it("never emits part of a secret while a second secret that overlaps it is still undecided", () => {
    // "abcdX" is complete, but its tail could still grow into "cdXYZ".
    expect(redact({ A: "abcdX", B: "cdXYZ" }, ["abcdX", "q"])).toBe("[redacted:A]q");
  });

  it("leaves values under four characters alone, since masking them would garble output", () => {
    expect(redact({ PIN: "123" }, ["port 1234"])).toBe("port 1234");
  });

  it("masks non-ASCII secrets and passes other bytes through unchanged", () => {
    const redactor = createRedactor({ PW: "contraseña" });
    const bytes = Buffer.from([0xff, 0x00, 0xc3, 0x28]);
    const out = Buffer.concat([redactor.write(Buffer.concat([bytes, Buffer.from("contraseña")])), redactor.flush()]);
    expect(out).toEqual(Buffer.concat([bytes, Buffer.from("[redacted:PW]")]));
  });
});

describe("parseEnvFlags", () => {
  it("splits on the first equals sign", () => {
    expect(parseEnvFlags(["A=bw://p/item/field", "B_2=bw://p/x=y/field"])).toEqual({ A: "bw://p/item/field", B_2: "bw://p/x=y/field" });
  });

  it("keeps a variable named __proto__ instead of dropping it", () => {
    expect(Object.keys(parseEnvFlags(["__proto__=bw://p/item/field"]))).toEqual(["__proto__"]);
  });

  it("rejects a flag without a valid variable name", () => {
    expect(() => parseEnvFlags(["bw://p/item/field"])).toThrow(/--env NAME=bw:/);
    expect(() => parseEnvFlags(["1BAD=bw://p/item/field"])).toThrow(/--env NAME=bw:/);
  });
});
