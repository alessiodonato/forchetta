#!/bin/sh
# Creates, once, the local signing certificate of Forchetta in the login keychain. build-app.sh signs the app with it
# when it is there: macOS then keeps the permissions it gave the app (such as the folder of the Desktop) across
# builds, which it does not with an ad-hoc signature, whose fingerprint changes at every build.
#
# The certificate is for code signing only, valid 10 years, not trusted by Apple: it signs your own builds, nothing
# else. Only codesign may use its key. The key and the certificate files are made in a private folder and deleted
# right after the import. To take it away: Accesso Portachiavi → login → "Forchetta (firma locale)" → Elimina.
set -eu
NAME="Forchetta (firma locale)"
if security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "Il certificato \"$NAME\" è già nel portachiavi."
  exit 0
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/var/tmp"
WORK=$(mktemp -d "$ROOT/var/tmp/cert.XXXXXX")
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -config "$WORK/cert.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
# A throwaway password for the file that carries the key into the keychain: the file is deleted on exit.
PASS=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" -out "$WORK/cert.p12" -passout "pass:$PASS"
security import "$WORK/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "Certificato \"$NAME\" creato nel portachiavi login: build-app.sh lo usa da ora."
