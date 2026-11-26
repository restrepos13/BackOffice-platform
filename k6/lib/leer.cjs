// Lee las líneas «R|{json}» que dejan las suites en k6/resultados/<suite>.log
const fs = require('fs');
module.exports = (suite) => fs.readFileSync(`${__dirname}/../resultados/${suite}.log`, 'utf8').split('\n')
  .map((l) => { const m = l.match(/msg="R\|(.*)"\s*(source=console)?\s*$/); if (!m) return null; try { return JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')); } catch { return null; } })
  .filter(Boolean);
