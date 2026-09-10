import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { userKeyRevealSchema } from "../router/v3-meta-schemas.js";
import { MetadataError, MetadataService } from "./metadata-service.js";

describe("user-key/reveal (owner-only)", () => {
  let store: SqliteMetadataStore;
  let svc: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    svc = new MetadataService(store, "test-instance");
  });

  afterEach(() => {
    store.close();
  });

  async function seedOwner() {
    return svc.createNormalUser({ username: "alice" });
  }

  async function seedOther() {
    return svc.createNormalUser({ username: "bob" });
  }

  /** Soft-revoke while keeping the row (store.revokeUserKey deletes). */
  function softRevoke(keyId: string) {
    const runner = store as unknown as {
      run: (sql: string, ...params: unknown[]) => void;
    };
    runner.run(
      "UPDATE meta_user_keys SET status = 'revoked', revoked_at = ? WHERE key_id = ?",
      new Date().toISOString(),
      keyId,
    );
  }

  it("schema accepts key_id", () => {
    const parsed = userKeyRevealSchema.safeParse({ key_id: "uky-abc" });
    expect(parsed.success).toBe(true);
  });

  it("owner reveal returns key_id + key_value", async () => {
    const owner = await seedOwner();
    const keys = await svc.listUserKeys(owner.user_id);
    const keyId = keys.items[0]!.key_id;

    const revealed = await svc.revealUserKeyForOwner(keyId, owner.user_id);
    expect(revealed).toEqual({
      key_id: keyId,
      key_value: owner.default_user_key,
    });
  });

  it("other user reveal is permission_denied", async () => {
    const owner = await seedOwner();
    const other = await seedOther();
    const keys = await svc.listUserKeys(owner.user_id);
    const keyId = keys.items[0]!.key_id;

    await expect(svc.revealUserKeyForOwner(keyId, other.user_id)).rejects.toMatchObject({
      name: "MetadataError",
      code: "permission_denied",
    });
  });

  it("admin cannot reveal another user's key (no assertUserScope bypass)", async () => {
    const owner = await seedOwner();
    const admin = await svc.createNormalUser({ username: "admin" });
    // Elevate to system_admin shape is irrelevant: reveal ignores admin flags.
    const keys = await svc.listUserKeys(owner.user_id);
    const keyId = keys.items[0]!.key_id;

    await expect(svc.revealUserKeyForOwner(keyId, admin.user_id)).rejects.toBeInstanceOf(
      MetadataError,
    );
    try {
      await svc.revealUserKeyForOwner(keyId, admin.user_id);
    } catch (err) {
      expect((err as MetadataError).code).toBe("permission_denied");
    }
  });

  it("revoked key is rejected", async () => {
    const owner = await seedOwner();
    const created = await svc.createUserKey(owner.user_id, { name: "extra" });
    softRevoke(created.key_id);

    await expect(
      svc.revealUserKeyForOwner(created.key_id, owner.user_id),
    ).rejects.toMatchObject({
      name: "MetadataError",
      code: "user_key_revoked",
    });
  });

  it("expired active key is rejected with user_key_expired", async () => {
    const owner = await seedOwner();
    const past = new Date(Date.now() - 60_000).toISOString();
    const created = await svc.createUserKey(owner.user_id, {
      name: "expired",
      expires_at: past,
    });

    await expect(
      svc.revealUserKeyForOwner(created.key_id, owner.user_id),
    ).rejects.toMatchObject({
      name: "MetadataError",
      code: "user_key_expired",
    });
  });

  it("missing key_id is user_key_not_found", async () => {
    const owner = await seedOwner();
    await expect(
      svc.revealUserKeyForOwner("uky-does-not-exist", owner.user_id),
    ).rejects.toMatchObject({
      name: "MetadataError",
      code: "user_key_not_found",
    });
  });
});
