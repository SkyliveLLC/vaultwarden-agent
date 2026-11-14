/**
 * Registers a throwaway account on a real Vaultwarden for the e2e test. The bw
 * CLI can't create accounts, so this does the client side of Bitwarden's
 * registration: derive the master key, wrap a new user key with it, and wrap a
 * new RSA key pair with the user key.
 */
import { createCipheriv, createHmac, generateKeyPairSync, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const KDF_ITERATIONS = 600_000;

/** Bitwarden's type 2 cipher string: AES-256-CBC, then HMAC-SHA256 over iv + ciphertext. */
function encrypt(data: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}

/** POSTs JSON or a form and returns the response body as text. */
async function post(url: string, body: Record<string, unknown> | URLSearchParams, token?: string): Promise<string> {
  const form = body instanceof URLSearchParams;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: form ? body : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url}: HTTP ${response.status} ${text}`);
  return text;
}

export interface TestAccount {
  email: string;
  password: string;
  clientId: string;
  clientSecret: string;
}

export async function registerAccount(server: string): Promise<TestAccount> {
  const email = `agent-${randomUUID()}@example.com`;
  const password = `e2e-${randomUUID()}`;

  const masterKey = pbkdf2Sync(password, email, KDF_ITERATIONS, 32, "sha256");
  const masterPasswordHash = pbkdf2Sync(masterKey, password, 1, 32, "sha256").toString("base64");
  // Bitwarden stretches the master key with HKDF-Expand alone. Node's hkdfSync always
  // extracts first, so expand by hand: one SHA-256 block covers the 32 bytes needed.
  const expand = (info: string) =>
    createHmac("sha256", masterKey)
      .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
      .digest();

  const userKey = randomBytes(64);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Without SMTP, Vaultwarden answers the verification request with the token itself.
  const emailVerificationToken = await post(`${server}/identity/accounts/register/send-verification-email`, {
    email,
    name: "E2E agent",
  });
  await post(`${server}/identity/accounts/register/finish`, {
    email,
    emailVerificationToken,
    masterPasswordHash,
    masterPasswordHint: null,
    userSymmetricKey: encrypt(userKey, expand("enc"), expand("mac")),
    userAsymmetricKeys: {
      publicKey: publicKey.toString("base64"),
      encryptedPrivateKey: encrypt(privateKey, userKey.subarray(0, 32), userKey.subarray(32)),
    },
    kdf: 0,
    kdfIterations: KDF_ITERATIONS,
  });

  const login = await post(
    `${server}/identity/connect/token`,
    new URLSearchParams({
      grant_type: "password",
      username: email,
      password: masterPasswordHash,
      scope: "api offline_access",
      client_id: "cli",
      deviceType: "8",
      deviceIdentifier: randomUUID(),
      deviceName: "vaultwarden-agent e2e",
    }),
  );
  const { access_token } = z.object({ access_token: z.string() }).parse(JSON.parse(login));
  const apiKey = await post(`${server}/api/accounts/api-key`, { masterPasswordHash }, access_token);
  const claims = Buffer.from(access_token.split(".")[1] ?? "", "base64url").toString();
  return {
    email,
    password,
    clientId: `user.${z.object({ sub: z.string() }).parse(JSON.parse(claims)).sub}`,
    clientSecret: z.object({ apiKey: z.string() }).parse(JSON.parse(apiKey)).apiKey,
  };
}
