# 升级包索引

本目录存放**基于官方源码 fork 后**每次发版给内网同事的升级契约（与具体 compose/ansible 解耦）。

## 用法（发版方）

1. 复制模板目录：`cp -r deploy/upgrades/_template deploy/upgrades/YYYY-MM-DD-<slug>`
2. 填写 `UPGRADE.md`、`env.add.yaml`、`MANIFEST.yaml`（镜像 tag、git commit）
3. 打镜像后把 `MANIFEST.yaml` 里的 tag 改成实际值
4. 与 `pack.sh` 产出的 `tdai-images.tgz` 一并交付

## 用法（部署方 / 同事）

1. 读对应版本的 `UPGRADE.md`
2. 用 `env.add.yaml` 合并进自己的 env / Secret 模板（可用 `yq` 或手工）
3. 按 `images` 段替换镜像 tag，滚动重启
4. 执行 `verify.sh`（或文档中的冒烟步骤）

## 已有升级包

| 版本 | 说明 |
|------|------|
| [2026-08-24-per-sk-mem-and-http-git](./2026-08-24-per-sk-mem-and-http-git/) | per-sk-mem MaaS API Key + HTTP Git clone |
