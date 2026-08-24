/**
 * per-sk-mem MaaS API Key — MongoDB 增量迁移
 * 集合：meta_user_key_maas_credentials（每把 sk-mem 绑定一把加密 MaaS Key）
 *
 * 幂等：createIndex 可重复执行。
 *
 * 用法:
 *   mongosh "$MONGODB_URI" --eval 'const dbName="tdai_metadata_default"' \
 *     MemoryCore/scripts/db/migrate-per-sk-mem-maas-mongo.js
 *
 * 说明：
 *   - 升级 MemoryCore 后，MongoMetadataStore.init() 也会自动 ensureIndex；
 *     本脚本供升级前手动检查或 CI 初始化。
 */

// eslint-disable-next-line no-undef
const database = db.getSiblingDB(typeof dbName !== "undefined" ? dbName : "tdai_metadata_default");

database.meta_user_key_maas_credentials.createIndex({ key_id: 1 }, { unique: true });
database.meta_user_key_maas_credentials.createIndex({ user_id: 1 });

const indexes = database.meta_user_key_maas_credentials.getIndexes().map((i) => i.name);
print(`[ok] ${database.getName()}.meta_user_key_maas_credentials indexes: ${indexes.join(", ")}`);
