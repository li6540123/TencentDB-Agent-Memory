import { describe, expect, it } from "vitest";
import { decryptMaasApiKey, encryptMaasApiKey, hintFromMaasApiKey } from "./maas-key-crypto.js";

describe("maas-key-crypto", () => {
  const secret = "test-secret-at-least-32-bytes-long!!";

  it("roundtrips encrypt/decrypt", () => {
    const plain = "sk-maas-company-gateway-key-12345";
    const ct = encryptMaasApiKey(plain, secret);
    expect(decryptMaasApiKey(ct, secret)).toBe(plain);
    expect(ct.startsWith("v1:")).toBe(true);
  });

  it("hintFromMaasApiKey returns last 4 chars", () => {
    expect(hintFromMaasApiKey("sk-abcd1234")).toBe("1234");
  });

  it("rejects missing secret", () => {
    expect(() => encryptMaasApiKey("x", "")).toThrow(/not configured/);
  });

  it("rejects bad ciphertext", () => {
    expect(() => decryptMaasApiKey("bad", secret)).toThrow();
  });
});
