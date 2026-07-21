#!/usr/bin/env bash
set -euo pipefail

revision="1dd40ed3834ae5fc20deee7deac960572eec6b56"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="/opt/moq-media-streaming/bin"

if [[ -x "$install_dir/moq-sub" ]]; then
  echo "$install_dir/moq-sub already exists"
  exit 0
fi

build_root="$(mktemp -d /tmp/transport-moq-sub-streaming.XXXXXX)"
source_dir="$build_root/moq-rs"
git clone --filter=blob:none https://github.com/cloudflare/moq-rs.git "$source_dir"
git -C "$source_dir" checkout "$revision"
git -C "$source_dir" apply "$script_dir/moq-sub-stream-objects.patch"

# The bootstrap installs the Rust toolchain under /opt, but its registry cache
# is populated by root. Give the benchmark user a private, writable cache while
# continuing to use the pinned system toolchain.
export CARGO_HOME="$HOME/.cargo"
export RUSTUP_HOME=/opt/rustup
export PATH="/opt/cargo/bin:$PATH"
cargo build --locked --release --manifest-path "$source_dir/Cargo.toml" --package moq-sub
sudo install -D -m 0755 "$source_dir/target/release/moq-sub" "$install_dir/moq-sub"
"$install_dir/moq-sub" --help >/dev/null
