#!/usr/bin/env bash
set -euo pipefail

node_temp_dir="$(mktemp -d)"
trap 'rm -r "$node_temp_dir"' EXIT
node_checksums="$node_temp_dir/SHASUMS256.txt"
curl --fail --silent --show-error \
  https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt \
  --output "$node_checksums"
node_archive="$(awk '$2 ~ /^node-v22\..*-linux-x64\.tar\.xz$/ { print $2; exit }' "$node_checksums")"
if [[ -z "$node_archive" ]]; then
  echo "Could not resolve the latest Node 22 Linux x64 archive" >&2
  exit 1
fi
curl --fail --silent --show-error \
  "https://nodejs.org/dist/latest-v22.x/$node_archive" \
  --output "$node_temp_dir/$node_archive"
(
  cd "$node_temp_dir"
  grep " $node_archive$" SHASUMS256.txt | sha256sum --check --strict
)
tar --extract --xz --file="$node_temp_dir/$node_archive" --directory=/usr/local --strip-components=1
node --version
npm --version
