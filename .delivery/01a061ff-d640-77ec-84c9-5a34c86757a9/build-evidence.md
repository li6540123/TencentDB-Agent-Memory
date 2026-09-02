# SUIB-12 Build Evidence (Dev T1–T3)

| Field | Value |
|-------|-------|
| Tag | `suib-12-20260902` |
| Build path | fallback `deploy/internal-team/build-local.sh` + proxy (Docker Hub timeout on publish.sh) |
| Host | macOS arm64 / colima aarch64 |
| Commit | `agent/full-delivery/suib-12-rebuild-amd64` |

## T1 — amd64 build (PASS)

```
tdai-local/memory-core:suib-12-20260902    linux/amd64
tdai-local/memory-proxy:suib-12-20260902   linux/amd64
tdai-local/memory-hub:suib-12-20260902     linux/amd64
```

Build command:
```bash
cd deploy/internal-team
PLATFORM=linux/amd64 TAG=suib-12-20260902 BUILD_PROXY_PORT=7897 ./build-local.sh
```

## T2 — deploy (PARTIAL)

- `deploy/global-images/verify.sh --skip-llm` → exit 0
- `tdai-memory-hub` → **Up (healthy)** on ports 8125/8424
- `tdai-memory-core` → **Exited(1)** — tsx/esbuild crash under amd64 QEMU on arm64 host
- `tdai-proxy` → **Exited(1)** — same root cause (runtime `node --import tsx`, no prebuilt dist)

## T3 — smoke (PARTIAL, 2 runs)

| Endpoint | Run1 | Run2 |
|----------|------|------|
| `:8125/health` | 200 | 200 |
| `:8424/health` | 200 | 200 |
| `:8424/docs` | 200 | 200 |
| `:8420/health` | down | down |
| `:8096/health` | down | down |

## Blocker

Full AC2/AC3 requires **linux/amd64 host** or PO-authorized minimal fix (pre-build dist in core/proxy Dockerfile). Per Q4 default: escalate to Leader/PO, no inline hotfix in this PR.
