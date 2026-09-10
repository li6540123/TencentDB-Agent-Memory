import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { userUpdateSchema } from "../router/v3-meta-schemas.js";
import type { V3AuthContext } from "../router/auth.js";
import { MetadataError, MetadataService } from "./metadata-service.js";

function adminCtx(userId = "usr-admin"): V3AuthContext {
  return { token: "sk-admin", userId, isAdmin: false, isSystemAdmin: true };
}

function normalCtx(userId = "usr-normal"): V3AuthContext {
  return { token: "sk-normal", userId, isAdmin: false, isSystemAdmin: false };
}

describe("user/update (admin profile sync)", () => {
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

  async function seedUser(overrides?: {
    username?: string;
    email?: string | null;
    display_name?: string | null;
    auth_provider?: string;
    external_id?: string;
  }) {
    return store.createUser({
      username: overrides?.username ?? "alice",
      email: overrides?.email ?? "alice@example.com",
      display_name: overrides?.display_name ?? "Alice",
      auth_provider: overrides?.auth_provider ?? "iam",
      external_id: overrides?.external_id ?? "alice@example.com",
      password: null,
      user_type: "normal",
    });
  }

  it("admin can update username / email / display_name", async () => {
    const user = await seedUser();
    svc.assertCanManageUsers(adminCtx());

    const updated = await svc.updateUserProfileForAdmin(user.user_id, {
      username: "alice_idp",
      email: "alice.new@example.com",
      display_name: "Alice IdP",
    });

    expect(updated.username).toBe("alice_idp");
    expect(updated.email).toBe("alice.new@example.com");
    expect(updated.display_name).toBe("Alice IdP");
    expect(updated.external_id).toBe(user.external_id);
    expect(updated.auth_provider).toBe(user.auth_provider);
    expect(updated.user_type).toBe("normal");
  });

  it("non-admin assertCanManageUsers throws permission_denied (403)", () => {
    expect(() => svc.assertCanManageUsers(normalCtx())).toThrow(MetadataError);
    try {
      svc.assertCanManageUsers(normalCtx());
    } catch (err) {
      expect(err).toBeInstanceOf(MetadataError);
      expect((err as MetadataError).code).toBe("permission_denied");
    }
  });

  it("cannot change external_id / auth_provider / user_type via schema or service", async () => {
    const user = await seedUser({
      auth_provider: "iam",
      external_id: "keep-me@example.com",
    });

    // Schema strips identity fields (zod default strip; not in whitelist).
    const parsed = userUpdateSchema.safeParse({
      user_id: user.user_id,
      username: "renamed",
      external_id: "hijack@example.com",
      auth_provider: "local",
      user_type: "system_admin",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ user_id: user.user_id, username: "renamed" });
    expect("external_id" in parsed.data).toBe(false);
    expect("auth_provider" in parsed.data).toBe(false);
    expect("user_type" in parsed.data).toBe(false);

    svc.assertCanManageUsers(adminCtx());
    const updated = await svc.updateUserProfileForAdmin(user.user_id, {
      username: parsed.data.username,
    });

    expect(updated.username).toBe("renamed");
    expect(updated.external_id).toBe("keep-me@example.com");
    expect(updated.auth_provider).toBe("iam");
    expect(updated.user_type).toBe("normal");
  });
});
