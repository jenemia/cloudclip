#!/usr/bin/env bash
# Create a local HTTPS certificate for testing on your LAN (phone <-> PC).
# Prefers mkcert (trusted by your devices once its root CA is installed);
# falls back to a self-signed openssl certificate (browser will warn).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs

names=(localhost 127.0.0.1 ::1)
# Add this machine's LAN IPs so a phone on the same Wi-Fi can connect.
if command -v ipconfig >/dev/null 2>&1; then # macOS
  for ifc in en0 en1; do ip=$(ipconfig getifaddr "$ifc" 2>/dev/null || true); [ -n "$ip" ] && names+=("$ip"); done
elif command -v hostname >/dev/null 2>&1; then
  for ip in $(hostname -I 2>/dev/null || true); do names+=("$ip"); done
fi
names+=("$@")

if command -v mkcert >/dev/null 2>&1; then
  mkcert -install
  mkcert -cert-file certs/cert.pem -key-file certs/key.pem "${names[@]}"
else
  echo "mkcert not found -> creating a self-signed certificate (browsers will show a warning)."
  san=""
  for n in "${names[@]}"; do
    if [[ "$n" =~ ^[0-9.]+$ || "$n" == *:* ]]; then san+="IP:$n,"; else san+="DNS:$n,"; fi
  done
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "/CN=cloudclip-dev" -addext "subjectAltName=${san%,}" 2>/dev/null
fi

echo
echo "Certificate for: ${names[*]}"
echo "Run:  TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem PORT=8443 npm start"
echo "Open: https://<LAN-IP>:8443 on your phone"
