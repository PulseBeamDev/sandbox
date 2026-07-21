#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /var/log/transport-bench-bootstrap.log) 2>&1

metadata_url="http://metadata.google.internal/computeMetadata/v1/instance/attributes/bench-role"
bench_role="$(curl --fail --silent --show-error -H 'Metadata-Flavor: Google' "$metadata_url")"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  build-essential \
  ca-certificates \
  clang \
  cmake \
  curl \
  docker-buildx \
  docker.io \
  ffmpeg \
  git \
  jq \
  libssl-dev \
  nodejs \
  npm \
  pkg-config \
  sysstat \
  chrony \
  xz-utils

# Ubuntu 24.04 currently ships Node 18.19, while node-datachannel requires
# 18.20 or newer. Install the frozen Node 22 build and verify its hash.
node_temp_dir="$(mktemp -d)"
node_version="22.23.1"
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_sha256="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
curl --fail --silent --show-error \
  "https://nodejs.org/dist/v${node_version}/$node_archive" \
  --output "$node_temp_dir/$node_archive"
(
  cd "$node_temp_dir"
  printf '%s  %s\n' "$node_sha256" "$node_archive" | sha256sum --check --strict
)
tar --extract --xz --file="$node_temp_dir/$node_archive" --directory=/usr/local --strip-components=1
rm -r "$node_temp_dir"

# Google recommends using only its internal, leap-smeared NTP source on GCE.
sed -i -E '/^(pool|server)[[:space:]]/d' /etc/chrony/chrony.conf
printf '%s\n' 'server metadata.google.internal iburst' >> /etc/chrony/chrony.conf
systemctl enable --now chrony
systemctl restart chrony
systemctl enable --now docker

export CARGO_HOME=/opt/cargo
export RUSTUP_HOME=/opt/rustup
if [[ ! -x "$CARGO_HOME/bin/cargo" ]]; then
  curl --proto '=https' --tlsv1.2 --silent --show-error --fail https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
fi
export PATH="$CARGO_HOME/bin:$PATH"

case "$bench_role" in
  publisher)
    cargo install --locked --root /opt/moq-media moq-pub@0.9.0
    ;;
  subscriber)
    cargo install --locked --root /opt/moq-media moq-sub@0.4.11
    ;;
  relay)
    cargo install --locked --root /opt/moq-media moq-relay-ietf@0.7.22
    docker pull ghcr.io/pulsebeamdev/pulsebeam:pulsebeam-v0.4.6
    ;;
  *)
    echo "Unsupported bench-role metadata: $bench_role" >&2
    exit 1
    ;;
esac

touch /var/lib/transport-bench-ready
