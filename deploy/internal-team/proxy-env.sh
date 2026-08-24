#!/usr/bin/env bash
# 本地 docker build / curl 走翻墙代理。
# 默认端口 7897（Clash 等）；可在 .env 设 BUILD_PROXY_PORT=7897 覆盖。
#
# 宿主机命令（curl/brew）：http://127.0.0.1:${PORT}
# docker build 容器内 RUN（apt/npm）：http://host.docker.internal:${PORT}

resolve_build_proxy() {
  local dir="${1:-.}"
  local port="${BUILD_PROXY_PORT:-7897}"

  if [[ -f "$dir/.env" ]]; then
    local from_env
    from_env=$(grep -E '^BUILD_PROXY_PORT=' "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "')
    [[ -n "$from_env" ]] && port="$from_env"
  fi

  export BUILD_PROXY_PORT="$port"
  export HOST_HTTP_PROXY="${HOST_HTTP_PROXY:-http://127.0.0.1:${port}}"
  export HOST_HTTPS_PROXY="${HOST_HTTPS_PROXY:-$HOST_HTTP_PROXY}"
  export DOCKER_HTTP_PROXY="${DOCKER_HTTP_PROXY:-http://host.docker.internal:${port}}"
  export DOCKER_HTTPS_PROXY="${DOCKER_HTTPS_PROXY:-$DOCKER_HTTP_PROXY}"
}

apply_host_proxy() {
  export HTTP_PROXY="$HOST_HTTP_PROXY"
  export HTTPS_PROXY="$HOST_HTTPS_PROXY"
  export http_proxy="$HOST_HTTP_PROXY"
  export https_proxy="$HOST_HTTPS_PROXY"
  export ALL_PROXY="${ALL_PROXY:-$HOST_HTTP_PROXY}"
}

# 供 docker build 展开用（勿用 mapfile / 勿带引号 echo，避免 buildx 解析失败）
docker_build_proxy_argv() {
  DOCKER_BUILD_PROXY_ARGV=(
    --add-host=host.docker.internal:host-gateway
    --build-arg "HTTP_PROXY=${DOCKER_HTTP_PROXY}"
    --build-arg "HTTPS_PROXY=${DOCKER_HTTPS_PROXY}"
    --build-arg "http_proxy=${DOCKER_HTTP_PROXY}"
    --build-arg "https_proxy=${DOCKER_HTTPS_PROXY}"
  )
}
