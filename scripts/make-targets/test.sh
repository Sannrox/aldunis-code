#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

ROOT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

cd "${ROOT_PATH}"

if [[ -n "${WHAT:-}" ]]; then
  read -r -a test_targets <<< "${WHAT}"
  npx --no-install tsx --test "${test_targets[@]}"
else
  npm test
fi
