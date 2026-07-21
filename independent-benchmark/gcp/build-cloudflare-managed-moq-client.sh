#!/usr/bin/env bash
set -euo pipefail

revision="d98b8fc798bae9904916bf959206aaaac3ee5472"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch_file="$script_dir/../patches/moq-sub-flush-stdout.patch"
install_dir="/opt/cloudflare-managed-moq/bin"
manifest_dir="/opt/transport-benchmark/manifests"
metadata_url="http://metadata.google.internal/computeMetadata/v1/instance/attributes/bench-role"
bench_role="$(curl --fail --silent --show-error -H 'Metadata-Flavor: Google' "$metadata_url")"

case "$bench_role" in
  publisher)
    package="moq-pub"
    binary="moq-pub"
    ;;
  subscriber)
    package="moq-sub"
    binary="moq-sub"
    ;;
  relay)
    echo "Cloudflare Managed MoQ has no binary to install on the self-hosted relay VM."
    exit 0
    ;;
  *)
    echo "Unsupported bench-role metadata: $bench_role" >&2
    exit 1
    ;;
esac

if [[ -x "$install_dir/$binary" ]]; then
  echo "$install_dir/$binary already exists"
  exit 0
fi

build_root="$(mktemp -d /tmp/transport-cloudflare-managed-moq.XXXXXX)"
trap 'rm -r "$build_root"' EXIT
source_dir="$build_root/moq-rs"
git clone --filter=blob:none https://github.com/cloudflare/moq-rs.git "$source_dir"
git -C "$source_dir" checkout --detach "$revision"
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  echo "Cloudflare draft-14 revision mismatch" >&2
  exit 1
fi
if [[ "$bench_role" == "subscriber" ]]; then
  git -C "$source_dir" apply "$patch_file"
fi

export CARGO_HOME="$HOME/.cargo"
export RUSTUP_HOME=/opt/rustup
export PATH="/opt/cargo/bin:$PATH"
cargo build --locked --release --manifest-path "$source_dir/Cargo.toml" --package "$package"
sudo install -D -m 0755 "$source_dir/target/release/$binary" "$install_dir/$binary"

sudo mkdir -p "$manifest_dir"
{
  printf 'implementation=cloudflare/moq-rs\n'
  printf 'service=Cloudflare Managed MoQ\n'
  printf 'protocol=draft-ietf-moq-transport-14\n'
  printf 'revision=%s\n' "$revision"
  printf 'role=%s\n' "$bench_role"
  if [[ "$bench_role" == "subscriber" ]]; then
    printf 'patch_sha256=%s\n' "$(sha256sum "$patch_file" | awk '{print $1}')"
  else
    printf 'patch_sha256=none\n'
  fi
  rustc --version
  cargo --version
  sha256sum "$install_dir/$binary"
} | sudo tee "$manifest_dir/cloudflare-managed-moq-$bench_role.txt"
