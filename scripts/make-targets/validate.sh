#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

ROOT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

validation_scripts=()
while IFS= read -r script; do
  validation_scripts+=("${script}")
done < <(
  find "${ROOT_PATH}/scripts" -maxdepth 1 -type f -name 'validate-*.sh' -print \
    | LC_ALL=C sort
)

if ((${#validation_scripts[@]} == 0)); then
  echo "No validation scripts found under ${ROOT_PATH}/scripts" >&2
  exit 1
fi

for script in "${validation_scripts[@]}"; do
  echo "Validating $(basename "${script}")"
  bash "${script}"
done
