import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { V3AuthContext } from "../router/auth.js";
import { MetadataError, MetadataService } from "./metadata-service.js";
import { toPublicUser } from "./user-visibility.js";

function adminCtx(userId = "usr-admin"): V3AuthContext {
  return { token: "sk-admin", userId, isAdmin: false, isSystemAdmin: true };
}

function normalCtx(userId = "usr-normal"): V3AuthContext {
  return { token: "sk-normal", userId, isAdmin: false, isSystemAdmin: false };
}

describe("bindExternalIdToUser overwrite guard + admin visibility", () => {
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

  it("toPublicUser exposes external_id/auth_provider only to system_admin", async () => {
    const user = await store.createUser({
      username: "bob",
      auth_provider: "iam",
      external_id: "bob@example.com",
      password: null,
      user_type: "normal",
    });

    const asAdmin = toPublicUser(user, adminCtx());
    expect(asAdmin.external_id).toBe("bob@example.com");
    expect(asAdmin.auth_provider).toBe("iam");

    const asSelf = toPublicUser(user, normalCtx(user.user_id));
    expect(asSelf.external_id).toBeUndefined();
    expect(asSelf.auth_provider).toBeUndefined();

    // Mirror getUserForCaller path used by user/get
    const viaGet = await svc.getUserForCaller(user.user_id, adminCtx());
    expect(viaGet.external_id).toBe("bob@example.com");
    expect(viaGet.auth_provider).toBe("iam");
  });

  it("refuses overwrite when target already has a different non-placeholder external_id", async () => {
    const user = await store.createUser({
      username: "carol",
      auth_provider: "iam",
      external_id: "carol-old@example.com",
      password: null,
      user_type: "normal",
    });

    await expect(
      svc.bindExternalIdToUser(user.user_id, "carol-new@example.com", "iam"),
    ).rejects.toMatchObject({
      name: "MetadataError",
      code: "target_already_bound_other_identity",
    });

    const still = await store.getUserById(user.user_id);
    expect(still?.external_id).toBe("carol-old@example.com");
  });

  it("allows bind when external_id is placeholder (= user_id)", async () => {
    const user = await store.createUser({
      username: "dave",
      auth_provider: "local",
      external_id: "placeholder-will-replace",
      password: null,
      user_type: "normal",
    });
    // Force placeholder shape used by local user_key accounts
    await store.updateUser(user.user_id, { external_id: user.user_id, auth_provider: "local" });

    const updated = await svc.bindExternalIdToUser(user.user_id, "dave@example.com", "iam");
    expect(updated.external_id).toBe("dave@example.com");
    expect(updated.auth_provider).toBe("iam");
  });

  it("allows idempotent re-bind of the same external_id", async () => {
    const user = await store.createUser({
      username: "erin",
      auth_provider: "iam",
      external_id: "erin@example.com",
      password: null,
      user_type: "normal",
    });
    const again = await svc.bindExternalIdToUser(user.user_id, "erin@example.com", "iam");
    expect(again.user_id).toBe(user.user_id);
    expect(again.external_id).toBe("erin@example.com");
  });

  it("throws external_id_already_bound when identity belongs to another user", async () => {
    await store.createUser({
      username: "owner",
      auth_provider: "iam",
      external_id: "shared@example.com",
      password: null,
      user_type: "normal",
    });
    const other = await store.createUser({
      username: "other",
      auth_provider: "local",
      external_id: "usr-other-placeholder",
      password: null,
      user_type: "normal",
    });
    await store.updateUser(other.user_id, { external_id: other.user_id });

    await expect(
      svc.bindExternalIdToUser(other.user_id, "shared@example.com", "iam"),
    ).rejects.toBeInstanceOf(MetadataError);

    try {
      await svc.bindExternalIdToUser(other.user_id, "shared@example.com", "iam");
    } catch (err) {
      expect((err as MetadataError).code).toBe("external_id_already_bound");
    }
  });
});
