#!/bin/sh
# Fetch the rclone that Decant bundles, check it against rclone's published
# SHA-256, and put it where Tauri expects a sidecar:
#   src-tauri/binaries/rclone-<target triple>[.exe]
#
# Usage: scripts/fetch-rclone.sh [target-triple]   (default: this machine's)
set -eu

VERSION=1.75.1
here=$(cd "$(dirname "$0")/.." && pwd)
triple=${1:-$(rustc -vV | sed -n 's/^host: //p')}

case "$triple" in
  x86_64-pc-windows-msvc)    asset=windows-amd64; ext=.exe ;;
  aarch64-pc-windows-msvc)   asset=windows-arm64; ext=.exe ;;
  x86_64-apple-darwin)       asset=osx-amd64;     ext= ;;
  aarch64-apple-darwin)      asset=osx-arm64;     ext= ;;
  x86_64-unknown-linux-gnu)  asset=linux-amd64;   ext= ;;
  aarch64-unknown-linux-gnu) asset=linux-arm64;   ext= ;;
  *) echo "No rclone build is mapped for $triple" >&2; exit 1 ;;
esac

name="rclone-v$VERSION-$asset"
base="https://downloads.rclone.org/v$VERSION"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -sSfL "$base/$name.zip" -o "$work/$name.zip"
curl -sSfL "$base/SHA256SUMS" -o "$work/SHA256SUMS"

expected=$(grep " $name.zip\$" "$work/SHA256SUMS" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$name.zip" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$work/$name.zip" | cut -d' ' -f1)
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $name.zip: expected '$expected', got '$actual'" >&2
  exit 1
fi

(cd "$work" && { unzip -q "$name.zip" 2>/dev/null || tar -xf "$name.zip"; })
mkdir -p "$here/src-tauri/binaries"
out="$here/src-tauri/binaries/rclone-$triple$ext"
cp "$work/$name/rclone$ext" "$out"
chmod +x "$out"
echo "rclone v$VERSION for $triple, SHA-256 verified -> ${out#"$here"/}"
