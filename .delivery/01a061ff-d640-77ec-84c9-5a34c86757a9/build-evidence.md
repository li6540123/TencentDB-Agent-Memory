# SUIB-12 Build Evidence (Dev T1–T3)

| Field | Value |
|-------|-------|
| Tag (arm64, PO-approved) | `suib-12-20260902-arm64` |
| Tag (amd64, record only) | `suib-12-20260902` |
| Build path | `deploy/internal-team/build-local.sh` |
| Deploy path | `deploy/global-images` |
| Host | macOS arm64 / colima aarch64 |
| PO decision | `po_verify_arch=arm64` — Mac 本机验证 arm64，amd64 构建保留记录 |
| Branch | `agent/full-delivery/suib-12-rebuild-amd64` |
| Baseline commit | `2a9f762` (release) |
| Verified at | 2026-09-02T20:42 CST |

## T1' — arm64 build (PASS)

```
tdai-local/memory-core:suib-12-20260902-arm64    linux/arm64
tdai-local/memory-proxy:suib-12-20260902-arm64   linux/arm64
tdai-local/memory-hub:suib-12-20260902-arm64     linux/arm64
```

```bash
cd deploy/internal-team
PLATFORM=linux/arm64 TAG=suib-12-20260902-arm64 BUILD_PROXY_PORT=7897 ./build-local.sh
```

## T1 — amd64 build (PASS, record only per PO)

```
tdai-local/memory-core:suib-12-20260902    linux/amd64
tdai-local/memory-proxy:suib-12-20260902   linux/amd64
tdai-local/memory-hub:suib-12-20260902     linux/amd64
```

## T2 — deploy arm64 (PASS)

- `deploy/global-images/verify.sh --skip-llm` → exit 0
- Containers: `tdai-memory-core`, `tdai-memory-hub`, `tdai-proxy` → **Up (healthy)**

## T3 — smoke arm64 (PASS, 2 runs)

| Endpoint | Run1 | Run2 |
|----------|------|------|
| `:8420/health` | 200 | 200 |
| `:8125/health` | 200 | 200 |
| `:8424/health` | 200 | 200 |
| `:8096/health` | 200 | 200 |
| `:8424/docs` | 200 | 200 |

## AC mapping (Mac local)

| AC | Status | Evidence |
|----|--------|----------|
| AC1 | PASS (arm64) | docker inspect → arm64 ×3 |
| AC2 | PASS | 3 containers Up healthy |
| AC3 | PASS | T0 smoke 5/5 ×2 |
