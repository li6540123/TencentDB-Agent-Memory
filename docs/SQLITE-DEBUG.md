# 现场查 SQLite（sqlite3 CLI）使用说明

本仓库的 `memory-core` 和 `memory-hub`（Panel + Knowledge）容器内部自带 SQLite 文件，
历史上统计/查询需要 `docker cp` 出来后用 Python 解析。

**SQLite 没有监听端口的服务端**。宿主机安装的 `sqlite3` **不能** 像连 MySQL 那样
连进容器。两条实际路径：

1. **`docker exec` 进容器**，用容器自带的 `sqlite3` 直接打开 db（推荐）。
2. db 已挂到宿主机卷 → 宿主机装的 `sqlite3` 对卷路径只读查询（不必改镜像）。

本仓库的测试/本机构建镜像已经装好 `sqlite3` CLI（详见下文），生产最瘦镜像**不**带，
按需用 `--build-arg WITH_SQLITE3=1` 自助启用。

---

## 1. 容器内 db 路径速查

| 容器 | db 路径（容器内） | 用途 | 是否已 volume 挂载 |
| --- | --- | --- | --- |
| `tdai-memory-core` | `/data/tdai-memory/vectors.db` | 记忆向量/索引 | 是 — `core-data` 卷 → `/data/tdai-memory` |
| `tdai-memory-core` | `/data/tdai-memory/metadata/tdai_metadata_<id>/metadata.db` | 元数据（user/key/team/task/asset/acl …） | 是（同上卷下子目录） |
| `tdai-memory-hub` (combined) | `${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}` | Knowledge Service 主库 | 是 — `hub-data` 卷 → `/data/knowledge` |

> 命名卷的真实挂载点可用 `docker volume inspect tdai-core-data --format '{{ .Mountpoint }}'` / `tdai-hub-data` 查到。

---

## 2. 哪些镜像自带 sqlite3

| 镜像 / Dockerfile | 是否带 `sqlite3` | 适用 |
| --- | --- | --- |
| `MemoryCore/Dockerfile` | ❌ 不带（生产最瘦） | 公开发布 |
| `MemoryCore/Dockerfile.local` | ✅ **带** | 本地/调试构建（`docker build -f Dockerfile.local ...`） |
| `MemoryPanel/docker/local/Dockerfile.local` | ✅ **带** | 本地 panel 构建 |
| `deploy/panel-knowledge-combined/Dockerfile` | 默认 ❌；`--build-arg WITH_SQLITE3=1` ✅ | 合并镜像（panel + knowledge） |

> 生产部署优先用 `MemoryCore/Dockerfile` / `MemoryKnowledge/Dockerfile` / 合并镜像**默认参数**，
> 不要把它们直接当调试镜像用。

---

## 3. 推荐查询方式：`docker exec` 只读

### 3.1 Core（`tdai-memory-core`）

```bash
# 版本自检
docker exec tdai-memory-core sqlite3 --version
# 期望：3.34.x 或更新（node:22-slim 镜像自带的版本）

# 列出表
docker exec tdai-memory-core sqlite3 \
  'file:/data/tdai-memory/vectors.db?mode=ro' '.tables'

# 一条只读 SQL（容器内直查，不需要 cp）
docker exec tdai-memory-core sqlite3 \
  'file:/data/tdai-memory/vectors.db?mode=ro' \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# 元数据库（每个 instance 一个文件）
docker exec tdai-memory-core sh -c 'ls /data/tdai-memory/metadata/'
docker exec tdai-memory-core sqlite3 \
  'file:/data/tdai-memory/metadata/tdai_metadata_default/metadata.db?mode=ro' \
  "SELECT count(*) AS team_rows FROM team;"
```

### 3.2 Hub 合并镜像（`tdai-memory-hub`）

```bash
docker exec tdai-memory-hub sqlite3 --version

docker exec tdai-memory-hub sqlite3 \
  'file:/data/knowledge/knowledge.db?mode=ro' '.tables'

# 一条只读统计
docker exec tdai-memory-hub sqlite3 \
  'file:/data/knowledge/knowledge.db?mode=ro' \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

### 3.3 Panel（`MemoryPanel/docker/local/Dockerfile.local`）

```bash
# panel 本地镜像内同样装了 sqlite3；panel 进程本身持有 better-sqlite3 连接，
# 查询时务必只读打开，避免与应用争抢。
docker exec tdai-memory-panel sqlite3 --version
```

---

## 4. 宿主机侧只读查询（可选；卷已挂载时适用）

容器数据已经被 `deploy/global-images/start-*.sh` 或 `deploy/internal-team/docker-compose.yml`
挂成命名卷（具体名字取决于启栈脚本；`start-*.sh` 默认是 `tdai-memory-core-data` /
`tdai-panel-data`，`internal-team` compose 默认是 `tdai-core-data` / `tdai-hub-data`，
可在 `.env` 改 `MEMORY_CORE_VOLUME` / `PANEL_VOLUME`）。
如果测试机也装了 `sqlite3`且能直接访问 docker 卷目录（Colima 走 VM，要在 VM 里跑）：

```bash
# 拿卷的宿主挂载点
docker volume inspect tdai-core-data --format '{{ .Mountpoint }}'   # 或 tdai-memory-core-data，按你的栈而定
docker volume inspect tdai-hub-data  --format '{{ .Mountpoint }}'   # 或 tdai-panel-data

CORE_DIR=$(docker volume inspect tdai-core-data --format '{{ .Mountpoint }}')
HUB_DIR=$(docker volume inspect tdai-hub-data  --format '{{ .Mountpoint }}')

sqlite3 -readonly "file:${CORE_DIR}/vectors.db?mode=ro" "SELECT name FROM sqlite_master WHERE type='table';"
sqlite3 -readonly "${HUB_DIR}/knowledge.db"            "SELECT name FROM sqlite_master WHERE type='table';"
```

> 这条路径**只是宿主机侧的便利**，不替代镜像内 `sqlite3`；写入仍要进容器。
> 卷目录拿不到（Mac + Colima / Docker Desktop）时，直接走 §3 `docker exec` 即可。

---

## 5. 只读约束 / 锁与 WAL 坑（务必读完）

- **默认只读**：统一用 URI `file:PATH?mode=ro` 打开；`-readonly` 标志同等效果。
  应用进程（`better-sqlite3` / `node:sqlite`）持有写连接，调试端写入会立即触发 `SQLITE_BUSY`。
- **WAL 模式下 `docker cp` 单个 `.db` 不完整**：仓库 SQLite 默认走 WAL，
  真实写入数据在 `*.db-wal`；只 cp 主文件再用宿主机 `sqlite3` 打开，会看到旧的、
  不一致的状态。`docker exec` 直接打开现场文件不会触发这个问题。
  一定要 cp 时：连同 `*.db`、`*.db-wal`、`*.db-shm` 三个文件一起拷，并在同一时刻
  用应用进程 checkpoint 或暂时停掉应用。
- **不要在调试端写库**。即便应用暂时空闲，better-sqlite3 会在事务里；
  调试端 `INSERT/UPDATE/DELETE` 会和业务事务交叉，破坏一致性。
  如果必须写，写前和应用团队协调，且先 `PRAGMA wal_checkpoint(TRUNCATE);`。
- **不要给生产镜像硬塞 sqlite3**。`MemoryCore/Dockerfile`（生产）和合并镜像默认参数
  都刻意保持最瘦；只在调试/测试构建里启用。
- **`apt-get install` 不持久**。在容器运行时手动装的 `sqlite3`，容器一重启就没了；
  不能当交付。按本文用 `Dockerfile.local` 或 `--build-arg WITH_SQLITE3=1` 重建镜像。

---

## 6. 复现脚本（验收用）

下面给出**完整可跑**的最小复现，适合做验收/冒烟：

### 6.1 MemoryCore 本地镜像

```bash
cd MemoryCore
docker build -f Dockerfile.local -t tdai-local/memory-core:sqlite3 .

# 起一个临时容器，挂空卷方便写入；不开业务，仅验证 CLI。
docker run -d --name core-smoke \
  -v core-smoke:/data/tdai-memory \
  tdai-local/memory-core:sqlite3

# 验证 sqlite3 已就位
docker exec core-smoke sqlite3 --version
docker exec core-smoke sh -c 'sqlite3 /data/tdai-memory/_smoke.db "CREATE TABLE IF NOT EXISTS t(a INT); INSERT INTO t VALUES(1);" && \
  sqlite3 "file:/data/tdai-memory/_smoke.db?mode=ro" ".tables" && \
  sqlite3 "file:/data/tdai-memory/_smoke.db?mode=ro" "SELECT * FROM t;"'

docker rm -f core-smoke
docker volume rm core-smoke
```

### 6.2 Hub 合并镜像（带 sqlite3 的本地构建）

```bash
cd deploy/panel-knowledge-combined
docker build --build-arg WITH_SQLITE3=1 -t team-memory-panel-knowledge:dev .

# 临时起一个空容器验证 CLI（不依赖外部依赖）
docker run -d --name hub-smoke \
  -v hub-smoke:/data/knowledge \
  team-memory-panel-knowledge:dev sleep infinity

docker exec hub-smoke sqlite3 --version
docker exec hub-smoke sh -c 'sqlite3 /data/knowledge/_smoke.db "CREATE TABLE IF NOT EXISTS t(a INT); INSERT INTO t VALUES(1);" && \
  sqlite3 "file:/data/knowledge/_smoke.db?mode=ro" ".tables" && \
  sqlite3 "file:/data/knowledge/_smoke.db?mode=ro" "SELECT * FROM t;"'

docker rm -f hub-smoke
docker volume rm hub-smoke
```

> 上面 `sleep infinity` 只是为了留出 exec 时间窗；不验证应用逻辑。
> 真实排障请用 `docker exec` 直接打开正在运行的容器里的 db（见 §3）。

---

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `docker exec ... sqlite3: executable file not found` | 镜像用的是生产 `Dockerfile`（无 sqlite3） | 改用 `Dockerfile.local`，或合并镜像加 `--build-arg WITH_SQLITE3=1` 重建 |
| `database is locked` | 与业务进程争写；或调试端开了非只读 URI | 强制 `?mode=ro`；短查询；不要写入 |
| `file is not a database` | cp 时漏了 `-wal`/`-shm`（WAL 不完整） | 不要 cp；改用 `docker exec`；或三个文件一起拷并 checkpoint |
| `node:sqlite` / `better-sqlite3` 业务报 `SQLITE_BUSY` | 调试端持锁太久 | 调试端短查询并 `?mode=ro`；写入前先协调 |
