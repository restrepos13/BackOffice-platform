#!/bin/bash
# Deja la base de pruebas como recién sembrada (borra lo que dejaron las corridas). Solo toca la base local aislada.
set -e
cd "$(dirname "$0")/.."
SEED_RESET_CONFIRM=backoffice_k6_pilot node k6/entorno.cjs pnpm db:seed:demo >/dev/null
node k6/entorno.cjs pnpm db:seed:nexus >/dev/null
redis-cli -p 6390 --scan --pattern 'k6-carga:*' | xargs -n 200 redis-cli -p 6390 del >/dev/null 2>&1 || true
mongosh --quiet --port 27021 backoffice_k6_pilot --eval 'print("contactos " + db.Contact.countDocuments() + " · conversaciones " + db.Conversation.countDocuments() + " · mensajes " + db.Message.countDocuments())'
