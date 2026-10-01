#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT_DIR="$PWD"
NODE_VERSION="v24.19.0"
usable_node() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; }
if ! usable_node; then
  case "$(uname -s)" in Linux) TARGET_OS=linux;; Darwin) TARGET_OS=darwin;; *) echo '此系统请安装 Node.js 22+，或在 Windows 使用 install.cmd。'; exit 1;; esac
  case "$(uname -m)" in x86_64) TARGET_ARCH=x64;; aarch64|arm64) TARGET_ARCH=arm64;; *) echo '此架构请自行准备 Node.js 22+。'; exit 1;; esac
  NODE_DIR="$ROOT_DIR/.data/node-runtime"
  if [ -x "$NODE_DIR/bin/node" ]; then export PATH="$NODE_DIR/bin:$PATH"; fi
  if ! usable_node; then
    mkdir -p "$ROOT_DIR/.data"
    DOWNLOAD_DIR="$(mktemp -d "$ROOT_DIR/.data/node-download.XXXXXX")"
    trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
    ARCHIVE="node-$NODE_VERSION-$TARGET_OS-$TARGET_ARCH.tar.gz"
    download() { if command -v curl >/dev/null 2>&1; then curl --fail --location --proto '=https' --tlsv1.2 "$1" --output "$2"; elif command -v wget >/dev/null 2>&1; then wget --https-only "$1" -O "$2"; else echo '需要 curl 或 wget 才能下载 Node.js。'; exit 1; fi; }
    echo '正在下载项目私有 Node.js 运行时，不修改系统安装…'
    download "https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE" "$DOWNLOAD_DIR/$ARCHIVE"
    download "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$DOWNLOAD_DIR/SHASUMS256.txt"
    EXPECTED_HASH="$(awk -v name="$ARCHIVE" '$2==name {print $1}' "$DOWNLOAD_DIR/SHASUMS256.txt")"
    if command -v sha256sum >/dev/null 2>&1; then ACTUAL_HASH="$(sha256sum "$DOWNLOAD_DIR/$ARCHIVE" | awk '{print $1}')"; else ACTUAL_HASH="$(shasum -a 256 "$DOWNLOAD_DIR/$ARCHIVE" | awk '{print $1}')"; fi
    if [ -z "$EXPECTED_HASH" ] || [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then echo 'Node.js 校验失败，已停止安装。'; exit 1; fi
    tar -xzf "$DOWNLOAD_DIR/$ARCHIVE" -C "$DOWNLOAD_DIR"
    "$DOWNLOAD_DIR/node-$NODE_VERSION-$TARGET_OS-$TARGET_ARCH/bin/node" --version
    if [ -e "$NODE_DIR" ]; then echo '现有私有运行时无效，请检查 .data/node-runtime 后重试。'; exit 1; fi
    mv "$DOWNLOAD_DIR/node-$NODE_VERSION-$TARGET_OS-$TARGET_ARCH" "$NODE_DIR"
    export PATH="$NODE_DIR/bin:$PATH"
    rm -rf "$DOWNLOAD_DIR"
    trap - EXIT
  fi
fi
case "${1:-}" in --run) exec node scripts/serve.mjs;; --stop) exec node scripts/serve.mjs --stop;; *) exec node scripts/setup/server.mjs;; esac
