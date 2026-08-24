#!/usr/bin/env python3
"""从环境变量渲染 runtime/tdai-gateway.yaml 与 runtime/proxy-config.yaml。"""
from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TPL = ROOT / "templates"
OUT = ROOT / "runtime"

DEFAULT_SOURCES = (
    "claude-code,codebuddy,codex,workbuddy,dsh,hermes,openclaw"
)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def src_to_suffix(source: str) -> str:
    return source.strip().upper().replace("-", "_")


def parse_list(raw: str) -> list[str]:
    return [x.strip() for x in raw.split(",") if x.strip()]


def yaml_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def env_int(name: str, default: int, minimum: int = 1) -> str:
    raw = env(name)
    if not raw:
        return str(default)
    try:
        n = int(raw)
    except ValueError as exc:
        raise SystemExit(f"[error] {name} 必须是整数，当前: {raw}") from exc
    if n < minimum:
        raise SystemExit(f"[error] {name} 必须 >= {minimum}，当前: {n}")
    return str(n)


def render_embedding_block() -> str:
    """记忆 hybrid 召回用的向量 embedding（可选）。Qwen3/BGE-M3 须 sendDimensions=false。"""
    enabled = env("MEMORY_EMBEDDING_ENABLED", "false").lower() in ("1", "true", "yes", "on")
    if not enabled:
        return "  embedding:\n    provider: none"

    provider = env("MEMORY_EMBEDDING_PROVIDER", "openai")
    base_url = env("MEMORY_EMBEDDING_BASE_URL")
    api_key = env("MEMORY_EMBEDDING_API_KEY")
    model = env("MEMORY_EMBEDDING_MODEL")
    if not base_url or not api_key or not model:
        raise SystemExit(
            "[error] MEMORY_EMBEDDING_ENABLED=1 时需设置 "
            "MEMORY_EMBEDDING_BASE_URL / API_KEY / MODEL"
        )

    dims = env_int("MEMORY_EMBEDDING_DIMENSIONS", 4096)
    send_raw = env("MEMORY_EMBEDDING_SEND_DIMENSIONS", "false").lower()
    send_dimensions = send_raw in ("1", "true", "yes", "on")

    lines = [
        "  embedding:",
        "    enabled: true",
        f"    provider: {yaml_quote(provider)}",
        f"    baseUrl: {yaml_quote(base_url)}",
        f"    apiKey: {yaml_quote(api_key)}",
        f"    model: {yaml_quote(model)}",
        f"    dimensions: {dims}",
        f"    sendDimensions: {'true' if send_dimensions else 'false'}",
    ]
    return "\n".join(lines)


def render_gateway() -> str:
    text = (TPL / "tdai-gateway.yaml").read_text()
    text = text.replace("${EMBEDDING_YAML}", render_embedding_block())
    replacements = {
        "MEMORY_LLM_BASE_URL": env("MEMORY_LLM_BASE_URL"),
        "MEMORY_LLM_API_KEY": env("MEMORY_LLM_API_KEY"),
        "MEMORY_LLM_MODEL": env("MEMORY_LLM_MODEL"),
        "MEMORY_LLM_MAX_TOKENS": env_int("MEMORY_LLM_MAX_TOKENS", 4096),
        "MEMORY_LLM_TIMEOUT_MS": env_int("MEMORY_LLM_TIMEOUT_MS", 120000),
        "MEMORY_SKILL_ARCHIVE_BYTES": env_int("MEMORY_SKILL_ARCHIVE_BYTES", 40960),
    }
    for key, value in replacements.items():
        text = text.replace("${" + key + "}", value)
    leftover = re.findall(r"\$\{[A-Z0-9_]+\}", text)
    if leftover:
        raise SystemExit(f"gateway 模板仍有未替换变量: {leftover}")
    return text


def agents_block() -> str:
    sources = parse_list(env("PROXY_AGENT_SOURCES", DEFAULT_SOURCES))
    mode = env("PROXY_KEY_MODE", "server").lower()
    passthrough_raw = env("PROXY_PASSTHROUGH_SOURCES")
    if passthrough_raw:
        passthrough = set(parse_list(passthrough_raw))
    elif mode == "passthrough":
        passthrough = set(sources)
    else:
        passthrough = set()

    default_url = env("PROXY_UPSTREAM_URL")
    default_key = env("PROXY_UPSTREAM_API_KEY")
    lines = ["  agents:"]
    for src in sources:
        suffix = src_to_suffix(src)
        url = env(f"PROXY_{suffix}_URL") or default_url
        key = env(f"PROXY_{suffix}_API_KEY") or default_key
        lines.append(f"    {src}:")
        lines.append(f"      url: {yaml_quote(url)}")
        if src in passthrough:
            lines.append("      # 不写 apiKey：透传该客户端请求头里的上游 Key")
        else:
            lines.append(f"      apiKey: {yaml_quote(key)}")
    return "\n".join(lines)


def s2s_token() -> str:
    """Hub/Proxy 调 Core 的 v3 需要非空 Bearer。Core 网关 Key 为空时用 local。"""
    core = env("MEMORY_CORE_GATEWAY_API_KEY")
    if core:
        return core
    return env("PROXY_CORE_SERVICE_TOKEN", "local") or "local"


def render_proxy() -> str:
    text = (TPL / "proxy-config.yaml").read_text()
    text = text.replace("${UPSTREAM_AGENTS_YAML}", agents_block())
    text = text.replace("${PROXY_CORE_SERVICE_TOKEN}", s2s_token())
    for key in (
        "PROXY_UPSTREAM_URL",
        "PROXY_UPSTREAM_API_KEY",
        "MEMORY_CORE_GATEWAY_API_KEY",
        "REDIS_PASSWORD",
        "PUBLIC_HOST",
        "PROXY_PORT",
    ):
        text = text.replace("${" + key + "}", env(key))
    if "${" in text:
        leftover = re.findall(r"\$\{[A-Z0-9_]+\}", text)
        raise SystemExit(f"模板仍有未替换变量: {leftover}")
    return text


def main() -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "tdai-gateway.yaml").write_text(render_gateway())
    (OUT / "proxy-config.yaml").write_text(render_proxy())
    print("[ok] 已写入 runtime/tdai-gateway.yaml runtime/proxy-config.yaml")


if __name__ == "__main__":
    main()
