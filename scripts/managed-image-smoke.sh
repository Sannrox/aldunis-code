#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: managed-image-smoke.sh <image> <shikigami-image> <shikigami-revision>}
shikigami_image=${2:?usage: managed-image-smoke.sh <image> <shikigami-image> <shikigami-revision>}
shikigami_revision=${3:?usage: managed-image-smoke.sh <image> <shikigami-image> <shikigami-revision>}

test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/amd64
test "$(docker image inspect --format '{{ index .Config.Labels "com.sannrox.aldunis.shikigami.image" }}' "$image")" = "$shikigami_image"
test "$(docker image inspect --format '{{ index .Config.Labels "com.sannrox.aldunis.shikigami.revision" }}' "$image")" = "$shikigami_revision"

if ! version_output=$(docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --memory 128m \
  --cpus 0.5 \
  --entrypoint /usr/local/bin/shikigami \
  "$image" version 2>&1); then
  echo "managed Code image does not contain a runnable Shikigami CLI" >&2
  exit 1
fi

version=$(printf '%s\n' "$version_output" |
  sed -nE 's/[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)
major=${version%%.*}
if [ -z "$version" ] || [ "$major" != 1 ] || ! printf '%s\n' 1.0.5 "$version" | sort -V -C; then
  echo "managed Code image contains unsupported Shikigami version: ${version:-unknown}" >&2
  exit 1
fi

echo "managed Code image smoke passed: $image with Shikigami $version"
