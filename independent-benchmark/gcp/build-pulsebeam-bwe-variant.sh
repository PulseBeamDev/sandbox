#!/usr/bin/env bash
set -euo pipefail

image="transport-pulsebeam:bwe-5m"
tag="pulsebeam-v0.4.6"
tag_object="3fe1cf7841713e90b2d502adc151a306aafa1c17"
revision="4fb1f66e549d00051860992acded9f4954b83029"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if sudo docker image inspect "$image" >/dev/null 2>&1; then
  echo "$image already exists"
  exit 0
fi

build_root="$(mktemp -d /tmp/transport-pulsebeam-bwe5m.XXXXXX)"
source_dir="$build_root/pulsebeam"
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch "$tag" \
  https://github.com/PulseBeamDev/pulsebeam.git "$source_dir"
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  echo "PulseBeam revision mismatch" >&2
  exit 1
fi
git -C "$source_dir" apply "$script_dir/pulsebeam-bwe-5m.patch"

# PulseBeam's Dockerfile uses BuildKit cache mounts. The benchmark bootstrap
# installs Ubuntu's docker-buildx package before this script is run.
sudo env DOCKER_BUILDKIT=1 docker build \
  --tag "$image" \
  --label "org.opencontainers.image.revision=$revision" \
  --label "transport-benchmark.patch-sha256=$(sha256sum "$script_dir/pulsebeam-bwe-5m.patch" | awk '{print $1}')" \
  "$source_dir"
sudo mkdir -p /opt/transport-benchmark/manifests
{
  printf 'implementation=PulseBeamDev/pulsebeam\n'
  printf 'tag=%s\n' "$tag"
  printf 'tag_object=%s\n' "$tag_object"
  printf 'revision=%s\n' "$revision"
  printf 'patch_sha256=%s\n' "$(sha256sum "$script_dir/pulsebeam-bwe-5m.patch" | awk '{print $1}')"
  sudo docker image inspect "$image" --format 'image_id={{.Id}} repo_tags={{json .RepoTags}}'
} | sudo tee /opt/transport-benchmark/manifests/pulsebeam-bwe-5m.txt
