/**
 * MaaS API Key 对称加密（AES-256-GCM）。
 * 主密钥来自环境变量 TDAI_MAAS_KEY_SECRET（仅 Core 持有）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "v1";
const IV_LEN = 12;

function deriveKey(secret: string): Buffer {
  if (!secret || secret.trim().length === 0) {
    throw new Error("TDAI_MAAS_KEY_SECRET is not configured");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** 展示用 hint：末 4 位。 */
export function hintFromMaasApiKey(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 4) return "****";
  return trimmed.slice(-4);
}

export function encryptMaasApiKey(plain: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptMaasApiKey(ciphertext: string, secret: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("invalid maas key ciphertext format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(secret);
  const iv = Buffer.from(ivB64!, "base64url");
  const tag = Buffer.from(tagB64!, "base64url");
  const data = Buffer.from(dataB64!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

export function readMaasKeySecretFromEnv(): string | undefined {
  const v = process.env.TDAI_MAAS_KEY_SECRET?.trim();
  return v && v.length > 0 ? v : undefined;
}
