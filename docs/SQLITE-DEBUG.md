# 现场查 SQLite（宿主机 sqlite3 CLI）使用说明

hub/core 的 SQLite 数据库**已经挂载到宿主机**（命名卷）。SQLite 没有监听端口的服务端，
宿主机装好 `sqlite3` 后，对挂载路径**只读**查询即可，不必 `docker cp` 也不必改镜像。

> 如果业务进程已经停掉，`apt-get install -y sqlite3` 装在镜像里那条路同样可用，但本仓库
> 的目标部署（compose / global-images 脚本栈）默认 db 已挂到卷 → **走宿主机**是默认推荐。

---

## 1. db 文件在哪

| 容器 | db 文件（容器内绝对路径） | 宿主卷 → 容器内目录 |
| --- | --- | --- |
| `tdai-memory-core` | `/data/tdai-memory/vectors.db`（记忆索引） | `<CORE_VOLUME_MOUNTPOINT>`/data/tdai-memory/vectors.db |
| `tdai-memory-core` | `/data/tdai-memory/metadata/tdai_metadata_<id>/metadata.db`（元数据） | `<CORE_VOLUME_MOUNTPOINT>`/data/tdai-memory/metadata/tdai_metadata_<id>/metadata.db |
| `tdai-memory-hub` (combined) | `${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}` | `<HUB_VOLUME_MOUNTPOINT>`/data/knowledge/knowledge.db |

**卷名按启栈脚本不同有两套**（都指同一组数据，只是命名卷名不同）：

| 启栈方式 | `core` 卷名 | `hub` 卷名 |
| --- | --- | --- |
| `deploy/global-images/start-*.sh` | `tdai-memory-core-data` | `tdai-panel-data` |
| `deploy/internal-team/docker-compose.yml` | `tdai-core-data` | `tdai-hub-data` |
| 自定义（`.env` 里改 `MEMORY_CORE_VOLUME` / `PANEL_VOLUME`） | 你自己起的名字 | 你自己起的名字 |

拿到宿主侧**绝对路径**用 `docker volume inspect`（这是真实路径，不是容器内路径）：

```bash
# global-images 启的栈
CORE_DIR=$(docker volume inspect tdai-memory-core-data --format '{{ .Mountpoint }}')
HUB_DIR=$(docker volume inspect tdai-panel-data          --format '{{ .Mountpoint }}')

# internal-team compose 启的栈
CORE_DIR=$(docker volume inspect tdai-core-data --format '{{ .Mountpoint }}')
HUB_DIR=$(docker volume inspect tdai-hub-data  --format '{{ .Mountpoint }}')

# 自定义卷名替换即可
```

> Mac + Colima / Docker Desktop：`Mountpoint` 是 VM 内路径，不能从 Mac 直接读。
> 在 VM 里 `colima ssh` 后跑下面命令，或用 `docker run --rm -v "$CORE_DIR:/data:ro" alpine:3.20 sh -c 'sqlite3 /data/...'` 这种「代理容器」拿一份只读视图。

---

## 2. 宿主机装 sqlite3

Debian/Ubuntu：

```bash
sudo apt-get update && sudo apt-get install -y sqlite3
sqlite3 --version    # 期望 3.34.x 或更新
```

其它系统：包管理器装 `sqlite3` 即可；版本 < 3.32 也能跑只读 SQL，但建议 3.34+ 以匹配
node:22-slim 镜像自带的版本。

---

## 3. 只读查询（推荐路径）

**强制用 URI `?mode=ro`**，让 SQLite 拒绝一切写入，避免和业务进程的 `better-sqlite3` /
`node:sqlite` 抢锁。

### 3.1 memory-core

```bash
# 表清单
sqlite3 "file:${CORE_DIR}/vectors.db?mode=ro" '.tables'

# 一条只读统计
sqlite3 "file:${CORE_DIR}/vectors.db?mode=ro" \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# 元数据库（每个 instance 一个文件；先列目录再查）
ls "${CORE_DIR}/metadata/"
sqlite3 "file:${CORE_DIR}/metadata/tdai_metadata_default/metadata.db?mode=ro" \
  "SELECT count(*) AS team_rows FROM team;"
```

### 3.2 memory-hub (combined)

```bash
sqlite3 "file:${HUB_DIR}/knowledge.db?mode=ro" '.tables'

sqlite3 "file:${HUB_DIR}/knowledge.db?mode=ro" \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

`-readonly` CLI 标志也等效：`sqlite3 -readonly "${HUB_DIR}/knowledge.db" '.tables'`。
两种风格混用没问题。

---

## 4. 别踩的坑（务必读完）

- **必须只读打开**。生产镜像里业务连接（`node:sqlite` / `better-sqlite3`）持有写连接；
  调试端 `INSERT/UPDATE/DELETE` 会立刻 `SQLITE_BUSY`，并破坏事务边界。用 `?mode=ro`
  或 CLI `-readonly` 把 SQLite 自己挡在最外层。
- **`docker cp` 单个 `.db` 在 WAL 下不完整**。本仓库的 SQLite 业务侧显式开了 WAL：
  - `MemoryKnowledge/src/db/client.ts:33` `raw.pragma("journal_mode = WAL");`
  - `MemoryCore/src/core/store/sqlite.ts:459` `this.db.exec("PRAGMA journal_mode = WAL");`

  真实写入数据常驻 `*.db-wal`；只 cp 主文件再用宿主机 `sqlite3` 打开，会看到旧的、
  不一致的状态。要 cp 时连 `*.db` / `*.db-wal` / `*.db-shm` 三个文件一起拷，并在
  拷贝前先 `PRAGMA wal_checkpoint(TRUNCATE);`（让应用短暂停一下做 checkpoint，或
  与应用团队协调停机窗口）。

  **走宿主机卷路径直接读 `Mountpoint` 不触发这个问题**，因为读的是同一份现场文件。

- **不要在调试端写库**。即便应用暂时空闲，`better-sqlite3` 仍可能持有事务；调试端
  `INSERT/UPDATE/DELETE` 会和业务事务交叉，破坏一致性。如必须写，先和应用团队协调，
  且先 `PRAGMA wal_checkpoint(TRUNCATE);`。

- **`Mac + Colima / Docker Desktop`**：`Mountpoint` 在 VM 内；从 Mac 直接读会
  `No such file`。要么 `colima ssh` 进 VM 跑，要么用代理容器（`docker run --rm
  -v "$VOL:/x:ro" alpine:3.20 sh -c 'sqlite3 /x/...'`）。原生 Linux 直接读。

- **不要把 sqlite3 装进镜像**。本仓库的 `MemoryCore/Dockerfile` /
  `MemoryKnowledge/Dockerfile` / 合并镜像默认参数刻意保持最瘦；本任务的目标是宿主机
  装 sqlite3，不是改镜像。

---

## 5. 复现脚本（验收用）

下面给出**完整可跑**的最小复现，对宿主机侧流程做端到端验证（不依赖任何业务镜像）：

```bash
# 1) 拿卷挂载点（global-images 启栈版）
CORE_DIR=$(docker volume inspect tdai-memory-core-data --format '{{ .Mountpoint }}')
HUB_DIR=$(docker volume inspect tdai-panel-data          --format '{{ .Mountpoint }}')

# 2) 宿主机装 sqlite3
sudo apt-get update && sudo apt-get install -y sqlite3
sqlite3 --version

# 3) 在 CORE_DIR 里建一个最小 db，模拟应用正在写（用单独副本避免碰真库）
TEST_DB="$(mktemp -d)/smoke.db"
sqlite3 "$TEST_DB" "CREATE TABLE t(a INT); INSERT INTO t VALUES(1);"

# 4) .tables + 只读 SELECT + 写入被拒
sqlite3 "file:${TEST_DB}?mode=ro" '.tables'                 # 期望：t
sqlite3 "file:${TEST_DB}?mode=ro" 'SELECT count(*) FROM t;'  # 期望：1
sqlite3 "file:${TEST_DB}?mode=ro" 'INSERT INTO t VALUES(2);'
# 期望错误：attempt to write a readonly database

# 5) 真库上跑一次只读 SELECT（不写入；不通就报告路径错误，别瞎改）
sqlite3 "file:${CORE_DIR}/vectors.db?mode=ro" \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 10;"
sqlite3 "file:${HUB_DIR}/knowledge.db?mode=ro" \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 10;"

rm -rf "$(dirname "$TEST_DB")"
```

---

## 6. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `No such file or directory`（Mac） | `Mountpoint` 在 VM 里 | `colima ssh` 进 VM 跑；或用代理容器；或读 `--mount` 出来的真实路径 |
| `attempt to write a readonly database` | 调试端开了写 URI | 强制 `?mode=ro` 或 CLI `-readonly` |
| `database is locked` | 业务进程持有写锁；调试端开了非只读 | 短查询；强制 `?mode=ro`；与业务协调 |
| `file is not a database` | 你读的是 WAL 不完整的副本 | 不要 cp 单文件；走 `Mountpoint` 直读现场文件 |
| `unable to open database file` | `Mountpoint` 路径写错；或当前用户没权限 | `ls -la` 验证；`chmod` / `sudo` 调整；或用代理容器（参考 §4） |
