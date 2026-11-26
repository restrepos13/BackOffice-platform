#!/bin/bash
# Muestra cada 5 s la memoria y CPU del API de pruebas mientras corre una suite: k6/medir-proceso.sh <archivo.csv> &
pid=$(lsof -ti tcp:4021 -sTCP:LISTEN | head -1)
echo "hora,rss_mb,cpu" > "$1"
while kill -0 "$pid" 2>/dev/null; do ps -o rss=,%cpu= -p "$pid" | awk -v h="$(date +%H:%M:%S)" '{printf "%s,%.0f,%s\n", h, $1/1024, $2}' >> "$1"; sleep 5; done
