import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";

export interface SecretKdfConfig {
  type: "scrypt";
  salt: string;
  N: number;
  r: number;
  p: number;
}

export interface EncryptedSecretPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface SecretCryptoConfig {
  kdf: SecretKdfConfig;
  passphrase?: string;
}

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const DEFAULT_KDF: Omit<SecretKdfConfig, "salt"> = { type: "scrypt", N: 32768, r: 8, p: 1 };

export function createDefaultKdf(): SecretKdfConfig {
  return { ...DEFAULT_KDF, salt: randomBytes(16).toString("base64") };
}

export function resolveSecretPassphrase(passphrase?: string): string {
  const explicit = passphrase ?? process.env.NEOCTL_SECRETS_KEY ?? process.env.NEO_SECRETS_KEY;
  if (explicit && explicit.length > 0) return explicit;
  // Local fallback keeps storage encrypted-at-rest without interactive prompting. Users who need stronger
  // separation should set NEOCTL_SECRETS_KEY; changing it makes existing secrets undecryptable.
  return `neoctl-local-secret-key:${process.env.USERPROFILE ?? process.env.HOME ?? "unknown"}`;
}

export function deriveSecretKey(config: SecretCryptoConfig): Buffer {
  const passphrase = resolveSecretPassphrase(config.passphrase);
  if (/^[A-Za-z0-9+/=]+$/.test(passphrase)) {
    try {
      const decoded = Buffer.from(passphrase, "base64");
      if (decoded.length === KEY_LENGTH) return decoded;
    } catch {
      // Fall through to scrypt.
    }
  }
  return scryptSync(passphrase, Buffer.from(config.kdf.salt, "base64"), KEY_LENGTH, {
    N: config.kdf.N,
    r: config.kdf.r,
    p: config.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecretPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(payload: EncryptedSecretPayload, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
