const fs = require("fs");
const splitCsv = (line) => {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
};
const lines = fs.readFileSync("logs/multi_extracted.csv", "utf8").split(/\r?\n/);
const macroIdRe = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const titleSpaceMap = new Map();
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const parts = splitCsv(line);
  const head0 = (parts[0] || "").toLowerCase();
  if (head0 === "pageid") continue;
  if (parts.length >= 4 && macroIdRe.test(parts[1])) {
    const spaceKey = parts[2];
    const title = parts[3];
    const tokens = parts.slice(4).filter(Boolean);
    console.log(`Row -> space=${JSON.stringify(spaceKey)} title=${JSON.stringify(title)} tokens=${JSON.stringify(tokens)}`);
    if (title && spaceKey) {
      const k = `${spaceKey}:${title}`;
      titleSpaceMap.set(k, tokens);
    }
  }
}
console.log("\ntitleSpaceMap (" + titleSpaceMap.size + " entries):");
for (const [k, v] of titleSpaceMap) console.log(`  ${JSON.stringify(k)} -> ${JSON.stringify(v)}`);
console.log("\nProbing missing lookups:");
for (const k of ["AI:2022 G&D", "AI:Augmented Grid Resilience"]) {
  console.log("  " + JSON.stringify(k) + ": " + JSON.stringify(titleSpaceMap.get(k)));
}
