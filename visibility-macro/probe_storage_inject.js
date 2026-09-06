// Probe: inject groupIds into the show-if via storage on page 200534574.
// One-off, used to validate that storage-format PUT keeps the param.

require("dotenv").config({ path: ".env" });
const Cloud = require("./src/cloudConfluenceClient");
const cloud = new Cloud(process.env.CLOUD_BASE_URL, process.env.CLOUD_EMAIL, process.env.CLOUD_API_TOKEN);

const id = "200534574";
const groupId = "00000000-0000-0000-0000-00000000g001"; // staff
const target = "00000005-0000-4000-8000-000000000005"; // macroId of show-if[group=staff]

(async () => {
  const pg = await cloud.getPageStorage(id);
  console.log("Title:", pg.title, "version:", pg.version?.number, "type:", pg.type);
  let v = pg.body?.storage?.value || "";
  console.log("storage size before:", v.length);

  const macroOpenIdx = v.indexOf('ac:macro-id="' + target + '"');
  if (macroOpenIdx === -1) { console.log("macro not found"); process.exit(1); }
  const openEnd = v.indexOf(">", macroOpenIdx) + 1;
  const rtbIdx = v.indexOf("<ac:rich-text-body>", openEnd);
  if (rtbIdx === -1) { console.log("rich-text-body not found"); process.exit(1); }
  const headerRegion = v.slice(openEnd, rtbIdx);
  if (headerRegion.indexOf('ac:name="groupIds"') !== -1) {
    console.log("groupIds already present");
    process.exit(0);
  }
  const inject = '<ac:parameter ac:name="groupIds">' + groupId + '</ac:parameter>';
  v = v.slice(0, rtbIdx) + inject + v.slice(rtbIdx);
  console.log("storage size after:", v.length);

  const macroStart = v.lastIndexOf("<ac:structured-macro", rtbIdx);
  console.log("modified macro (first 700 chars):");
  console.log(v.slice(macroStart, macroStart + 700));

  const result = await cloud.updatePageStorage(
    id, pg.title, pg.type || "page", v, pg.version.number,
    "Probe: add groupIds to legacy-content-wrapped show-if"
  );
  console.log("\nPUT result:", result);

  // Re-fetch and check
  const after = await cloud.getPageStorage(id);
  const av = after.body?.storage?.value || "";
  const hasGroupIds = av.indexOf('ac:name="groupIds">' + groupId + '<') !== -1;
  console.log("\nAfter PUT, version:", after.version?.number);
  console.log("groupIds round-tripped to storage:", hasGroupIds);
})().catch(e => { console.error("FATAL", e.message, e.stack); process.exit(1); });
