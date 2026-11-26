#!/bin/bash
# Corre un perfil de carga midiendo memoria y CPU del API:  k6/correr-carga.sh pico
cd "$(dirname "$0")/.."
p="$1"; csv="k6/resultados/05-carga-$p.proceso.csv"
# Espera a que el API esté en reposo (sin trabajo pendiente de la corrida anterior)
for i in $(seq 1 120); do t=$(curl -s -m 3 -o /dev/null -w '%{time_total}' http://localhost:4021/api/health || echo 9); awk "BEGIN{exit !($t<0.05)}" && break; sleep 3; done
k6/medir-proceso.sh "$csv" & M=$!
K6_NOMBRE="05-carga-$p" k6/correr.sh 05-carga -e PERFIL="$p" 2>&1 | grep -v '^$' | tail -3
kill $M 2>/dev/null; wait $M 2>/dev/null
tail -n +2 "$csv" | awk -F, 'NR==1{min=$2;max=$2} {if($2<min)min=$2;if($2>max)max=$2;if($3>c)c=$3;u=$2} END{printf "   API: memoria %d→%d MB (máx %d) · CPU máx %s%%\n", min,u,max,c}'
node -e 'const j=require("./k6/resultados/05-carga-'$p'.json");const r=x=>x==null?"—":Math.round(x);for(const[k,v]of Object.entries(j.extra))console.log("   "+k+": "+(v.count!==undefined?v.count:v.rate!==undefined?(v.rate*100).toFixed(2)+"%":"med "+r(v.med)+" · p95 "+r(v["p(95)"])+" · p99 "+r(v["p(99)"])+" · máx "+r(v.max)+" ms"))'
