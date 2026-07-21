#!/usr/bin/env bash
set -euo pipefail

revision="b0115deeed82792a4dee41bb783b580fa03fbbfe"
root="$HOME/independent-benchmark"
source_dir="$root/.tools/moq-dev-src"
install_dir="/opt/hosted-moq-bench/bin"
manifest_dir="/opt/transport-benchmark/manifests"
latency_patch="$root/patches/moq-dev-immediate-zero-fragment.patch"
metadata_url="http://metadata.google.internal/computeMetadata/v1/instance/attributes/bench-role"
bench_role="$(curl --fail --silent --show-error -H 'Metadata-Flavor: Google' "$metadata_url")"

mkdir -p "$root/.tools"
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none https://github.com/moq-dev/moq.git "$source_dir"
fi
git -C "$source_dir" fetch --filter=blob:none origin "$revision"
git -C "$source_dir" checkout --detach "$revision"
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  echo "moq.dev revision mismatch" >&2
  exit 1
fi
if git -C "$source_dir" apply --reverse --check "$latency_patch" 2>/dev/null; then
  echo "moq.dev zero-fragment latency patch already applied"
else
  git -C "$source_dir" apply --check "$latency_patch"
  git -C "$source_dir" apply "$latency_patch"
fi

export CARGO_HOME="$HOME/.cargo"
export RUSTUP_HOME=/opt/rustup
export PATH="/opt/cargo/bin:$PATH"
case "$bench_role" in
  publisher|subscriber)
    cargo build --locked --release --manifest-path "$source_dir/Cargo.toml" --package moq-cli
    cargo build --locked --release --manifest-path "$root/moq-dev-agent/Cargo.toml"
    sudo install -D -m 0755 "$source_dir/target/release/moq" "$install_dir/moq"
    sudo install -D -m 0755 "$root/moq-dev-agent/target/release/moq-dev-benchmark-agent" "$install_dir/moq-dev-benchmark-agent"
    installed=("$install_dir/moq" "$install_dir/moq-dev-benchmark-agent")
    ;;
  relay)
    cargo build --locked --release --manifest-path "$source_dir/Cargo.toml" --package moq-relay
    sudo install -D -m 0755 "$source_dir/target/release/moq-relay" "$install_dir/moq-relay"
    installed=("$install_dir/moq-relay")
    ;;
  *)
    echo "Unsupported bench-role metadata: $bench_role" >&2
    exit 1
    ;;
esac
sudo mkdir -p "$manifest_dir"
{
  printf 'implementation=moq-dev/moq\n'
  printf 'revision=%s\n' "$revision"
  printf 'latency_patch_sha256=%s\n' "$(sha256sum "$latency_patch" | awk '{print $1}')"
  printf 'role=%s\n' "$bench_role"
  rustc --version
  cargo --version
  sha256sum "${installed[@]}"
} | sudo tee "$manifest_dir/moq-dev-hosted-clients.txt"
