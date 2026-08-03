#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: npm run wlan -- [options]

Start Aldunis Code in authenticated private-WLAN mode.

Options:
  --host <address>       Private WLAN address to bind (auto-detected by default)
  --port <number>        HTTPS port (default: 4174)
  --public-url <origin>  Certificate-matched HTTPS origin
  --tls-cert <path>      PEM certificate; mkcert is used when omitted
  --tls-key <path>       PEM private key; mkcert is used when omitted
  --no-build             Reuse the existing web build
  -h, --help             Show this help

Environment overrides:
  ALDUNIS_WLAN_HOST
  ALDUNIS_WLAN_PORT
  ALDUNIS_WLAN_PUBLIC_URL
  ALDUNIS_WLAN_TLS_CERT
  ALDUNIS_WLAN_TLS_KEY
EOF
}

fail() {
  printf 'wlan: %s\n' "$*" >&2
  exit 1
}

host="${ALDUNIS_WLAN_HOST:-}"
port="${ALDUNIS_WLAN_PORT:-4174}"
public_url="${ALDUNIS_WLAN_PUBLIC_URL:-}"
cert_path="${ALDUNIS_WLAN_TLS_CERT:-}"
key_path="${ALDUNIS_WLAN_TLS_KEY:-}"
skip_build=0

while (($# > 0)); do
  case "$1" in
    --host)
      (($# >= 2)) || fail "--host requires an address"
      host="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || fail "--port requires a number"
      port="$2"
      shift 2
      ;;
    --public-url)
      (($# >= 2)) || fail "--public-url requires an HTTPS origin"
      public_url="$2"
      shift 2
      ;;
    --tls-cert)
      (($# >= 2)) || fail "--tls-cert requires a path"
      cert_path="$2"
      shift 2
      ;;
    --tls-key)
      (($# >= 2)) || fail "--tls-key requires a path"
      key_path="$2"
      shift 2
      ;;
    --no-build)
      skip_build=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ "$port" =~ ^[0-9]+$ ]] || fail "port must be a number"
port_number=$((10#$port))
((port_number >= 1 && port_number <= 65535)) || fail "port must be between 1 and 65535"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "${script_directory}/.."

if [[ -z "$host" ]]; then
  if command -v networksetup >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    wifi_device="$(networksetup -listallhardwareports 2>/dev/null \
      | awk '/Hardware Port: (Wi-Fi|AirPort)/ { getline; print $2; exit }' || true)"
    if [[ -n "$wifi_device" ]]; then
      host="$(ipconfig getifaddr "$wifi_device" 2>/dev/null || true)"
    fi
  fi
fi

if [[ -z "$host" ]] && command -v ip >/dev/null 2>&1; then
  host="$(ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '{ for (index = 1; index <= NF; index += 1) if ($index == "src") { print $(index + 1); exit } }' || true)"
fi

[[ -n "$host" ]] || fail "could not detect a WLAN address; pass --host <private-address>"

url_host="$host"
if [[ "$url_host" == *:* && "$url_host" != \[*\] ]]; then
  url_host="[${url_host}]"
fi
if [[ -z "$public_url" ]]; then
  public_url="https://${url_host}:${port}"
fi
case "$public_url" in
  https://*) ;;
  *) fail "--public-url must be an HTTPS origin" ;;
esac

temporary_directory=""
cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -f -- "${temporary_directory}/cert.pem" "${temporary_directory}/key.pem"
    rmdir -- "$temporary_directory" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -n "$cert_path" || -n "$key_path" ]]; then
  [[ -n "$cert_path" && -n "$key_path" ]] || fail "--tls-cert and --tls-key must be supplied together"
  [[ -r "$cert_path" ]] || fail "TLS certificate is not readable: $cert_path"
  [[ -r "$key_path" ]] || fail "TLS key is not readable: $key_path"
else
  command -v mkcert >/dev/null 2>&1 \
    || fail "no TLS files supplied; install mkcert or pass --tls-cert and --tls-key"

  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/aldunis-code-wlan.XXXXXX")"
  public_hostname="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$public_url" 2>/dev/null)" \
    || fail "invalid --public-url: $public_url"
  cert_names=("$host")
  if [[ "$public_hostname" != "$host" ]]; then
    cert_names+=("$public_hostname")
  fi
  mkcert \
    -cert-file "${temporary_directory}/cert.pem" \
    -key-file "${temporary_directory}/key.pem" \
    "${cert_names[@]}"
  cert_path="${temporary_directory}/cert.pem"
  key_path="${temporary_directory}/key.pem"
  printf 'Using a temporary mkcert certificate. Trust the mkcert root CA on the client device (run: mkcert -CAROOT).\n'
fi

if ((skip_build == 0)); then
  npm run build:web
fi

npm run cli -- serve \
  --remote lan \
  --host "$host" \
  --port "$port" \
  --public-url "$public_url" \
  --tls-cert "$cert_path" \
  --tls-key "$key_path"
