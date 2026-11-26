#!/bin/bash
# Corre una suite contra el entorno aislado:  k6/correr.sh 03-seguridad [-e PERFIL=pico]
# Antes desbloquea las cuentas que una corrida anterior haya dejado bloqueadas (solo en la base de pruebas).
set -e
cd "$(dirname "$0")/.."
suite="$1"; shift
mongosh --quiet --port 27021 backoffice_k6_pilot --eval 'db.User.updateMany({}, {$set: {lockedUntil: null, failedLogins: 0}})' >/dev/null
salida="k6/resultados/${K6_NOMBRE:-$suite}"
rm -f "$salida.log"
node k6/entorno.cjs k6 run --quiet --console-output "$salida.log" "$@" "k6/$suite.js"
