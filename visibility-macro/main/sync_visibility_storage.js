#!/usr/bin/env node

/**
 * Storage-path companion to sync_visibility_macros.js. Targets pages where
 * Cloud's CCMA migration left visibility show-if/hide-if macros buried
 * inside `legacy-content` extension wrappers (or wherever they don't surface
 * as bodiedExtension nodes in ADF). The original ADF-based sync misses
 * these because its walker only descends into bodiedExtension content.
 *
 * Approach:
 *   1. CQL-scan Cloud for `macro in ("show-if","hide-if")`.
 *   2. For each match: fetch BODY.STORAGE (XHTML).
 *   3. Find every show-if/hide-if in storage via existing extractor.
 *   4. Find DC counterpart by space+title, classify each via the existing
 *      VMP._classifyDcMacro (visibility / scaffolding / unknown).
 *   5. For each VISIBILITY macro that doesn't already have a populated
 *      `groupIds` parameter, inject `<ac:parameter ac:name="groupIds">
 *      UUIDs</ac:parameter>` (and `users` for accountIds), with values
 *      resolved via IdentityResolver.
 *   6. PUT page back via STORAGE representation.
 *
 *   --plan-only --space <KEY|--all>      build plan, no Cloud writes
 *   --execute-only --plan-file <path>    apply existing plan
 *   --dry-run                            execute path simulates only
 *   --concurrency <n>                    default 5
 *   --limit <n>                          cap candidate pages
 *   --space <KEY[,KEY...]>               space filter
 *   --all                                scan every space
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterConfluenceClient = require("../src/datacenterConfluenceClient");
const CloudConfluenceClient = require("../src/cloudConfluenceClient");
const IdentityResolver = require("../src/identityResolver");
const VisibilityMacroProcessor = require("../src/visibilityMacroProcessor");

function parseArgs(argv) {
  const o = { planOnly:false, executeOnly:false, planFile:null,
    concurrency:5, limit:0, dryRun:false, spaceKeys:[], scanAllSpaces:false, help:false };
  for (let i=0;i<argv.length;i++){
    const a=argv[i];
    switch(a){
      case "--plan-only": o.planOnly=true; break;
      case "--execute-only": case "--resume": o.executeOnly=true; break;
      case "--plan-file": o.planFile=argv[++i]; break;
      case "--concurrency": o.concurrency=parseInt(argv[++i],10)||5; break;
      case "--limit": o.limit=parseInt(argv[++i],10)||0; break;
      case "--dry-run": o.dryRun=true; break;
      case "--space": o.spaceKeys=(argv[++i]||"").split(",").map(s=>s.trim()).filter(Boolean); break;
      case "--all": o.scanAllSpaces=true; break;
      case "--help": case "-h": o.help=true; break;
    }
  }
  return o;
}

function help(){console.log(`
Usage: node main/sync_visibility_storage.js [options]

Plan + execute via STORAGE representation (handles legacy-content-wrapped macros
that the ADF-based sync misses).

  --plan-only --space <K|--all>      build plan, no Cloud writes
  --execute-only --plan-file <path>  apply plan
  --dry-run                          simulate writes
  --space K[,K...] | --all
  --concurrency N (default 5)
  --limit N
`); }

class StorageSync {
  constructor(opts){
    this.opts=opts;
    this.logDir=path.join(__dirname,"../logs");
    if(!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir,{recursive:true});
    this.logFile=path.join(this.logDir,`storage_sync_${Date.now()}.log`);
    fs.writeFileSync(this.logFile,`Sync Visibility (Storage Path) Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`);

    this.dcClient=new DatacenterConfluenceClient(
      process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD,
      { pat: process.env.DC_PAT });
    this.cloudClient=new CloudConfluenceClient(
      process.env.CLOUD_BASE_URL, process.env.CLOUD_EMAIL, process.env.CLOUD_API_TOKEN);
    this.resolver=new IdentityResolver(this.cloudClient,{
      cacheDir: this.logDir, log:(m)=>this.log(m)
    });
    this.proc=new VisibilityMacroProcessor(this.dcClient,this.cloudClient,null,this.resolver,
      { macroNames:["show-if","hide-if"], log:(m)=>this.log(m) });

    this.stats={
      cloudPagesFound:0, pagesPlanned:0, macrosToUpdate:0,
      pagesUpdated:0, pagesSkipped:0, pagesFailed:0,
      macrosUpdated:0, macrosNoChange:0, macrosUnresolved:0,
    };
  }
  log(msg){
    const line=`[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    try{fs.appendFileSync(this.logFile,line+"\n");}catch(_){}
  }
  async testConnections(){
    this.log("Step 1: Testing connections...");
    if(!await this.dcClient.testConnection()) throw new Error("DC connection failed");
    this.log("  Datacenter: OK");
    if(!await this.cloudClient.testConnection()) throw new Error("Cloud connection failed");
    this.log("  Cloud: OK");
  }
  async runPool(items,workerFn,concurrency){
    let idx=0; const total=items.length; let done=0;
    const workers=Array.from({length:concurrency},async()=>{
      while(true){
        const i=idx++; if(i>=total) return;
        try{ await workerFn(items[i],i); }catch(e){ this.log(`  worker error: ${e.message}`); }
        done++; if(done%50===0) this.log(`  Progress: ${done}/${total}`);
      }
    });
    await Promise.all(workers);
  }

  // ─── PHASE 1: BUILD PLAN ────────────────────────────────────────────
  async buildPlan(){
    if(!this.opts.scanAllSpaces && this.opts.spaceKeys.length===0)
      throw new Error("Specify --space KEY[,KEY,...] or --all");

    const spaces = this.opts.spaceKeys.length>0
      ? this.opts.spaceKeys.map(k=>({key:k,name:k}))
      : [{key:null,name:"<all>"}];

    const candidates=[];
    for(const sp of spaces){
      this.log(`\nScanning space: ${sp.name}`);
      const cqlBase=sp.key
        ? `space = "${sp.key}" AND macro in ("show-if","hide-if") AND type = page`
        : `macro in ("show-if","hide-if") AND type = page`;
      let stop=false;
      await this.cloudClient.searchContentByCql(cqlBase,"version,space",async(results)=>{
        for(const p of results){
          this.stats.cloudPagesFound++;
          candidates.push(p);
          if(this.opts.limit>0 && candidates.length>=this.opts.limit){ stop=true; break; }
        }
        if(stop) return false;
      });
      if(stop) break;
    }
    this.log(`\n  Candidate pages: ${candidates.length}`);

    const planPages={};

    await this.runPool(candidates,async(cp)=>{
      const id=cp.id, title=cp.title, spaceKey=cp.space?.key;
      let storagePage;
      try{ storagePage = await this.cloudClient.getPageStorage(id); }
      catch(e){ this.log(`    "${title}" (${id}): storage fetch fail: ${e.message}`); return; }
      const storage = storagePage.body?.storage?.value || "";
      if(!storage) return;

      const cloudMacros = this.proc.extractDcParamsFromStorage(storage);
      if(cloudMacros.length===0) return;

      // DC lookup
      let dcStorage="", dcPageId=null;
      if(spaceKey){
        const cql=`space = "${spaceKey}" AND title = "${title.replace(/"/g,'\\"')}" AND type = page`;
        try{
          await this.dcClient.searchContentByCql(cql,"body.storage",async(results)=>{
            if(results.length>0){ dcPageId=results[0].id; dcStorage=results[0].body?.storage?.value||""; return false; }
          });
        }catch(e){ /* swallow; we'll skip per-macro */ }
      }
      const dcMacros = dcStorage ? this.proc.extractDcParamsFromStorage(dcStorage) : [];
      const dcById = new Map();
      for(const m of dcMacros) if(m.macroId) dcById.set(m.macroId, m);

      const macrosToUpdate=[];
      for(let i=0;i<cloudMacros.length;i++){
        const cm=cloudMacros[i];

        // CRITICAL: classify by Cloud storage's OWN params, not DC.
        // DC may have more macros than Cloud storage (e.g. visibility ones
        // migrated to Forge bodied extensions are absent from Cloud storage),
        // so ordinal/macroId-fallback alignment to DC mismatches the wrong
        // pair and would inject groupIds into the wrong (scaffolding) macro.
        // Cloud storage is authoritative for what's actually there NOW.
        const cloudKind=this.proc._classifyDcMacro(cm);
        if(cloudKind!=="visibility") continue; // only touch macros that have a visibility param in their own storage

        // Names come from Cloud storage. DC is consulted ONLY as a tiebreak
        // when cloud has empty visibility-param values (rare).
        const dc=(cm.macroId && dcById.get(cm.macroId)) || null;
        const groupNames = (cm.params?.group || cm.params?.groups || cm.params?.["user-groups"] ||
                            dc?.params?.group || dc?.params?.groups || dc?.params?.["user-groups"] || "").trim();
        const userNames  = (cm.params?.users || cm.params?.user ||
                            dc?.params?.users || dc?.params?.user || "").trim();

        // Already populated? Check Cloud storage's groupIds/users param.
        const existingGroupIds = (cm.params?.groupIds || "").trim();
        const existingUsers = (cm.params?.users || "").trim();

        const groupRes = await this.resolver.resolveList(groupNames,"group");
        const userRes  = await this.resolver.resolveList(userNames,"user");

        // Skip if nothing actionable
        if(!groupNames && !userNames) continue;
        // Skip if already populated and unchanged (idempotency)
        const wantGroupIds = groupRes.ids;
        const wantUsers = userRes.ids;
        if(existingGroupIds===wantGroupIds && existingUsers===wantUsers) continue;

        macrosToUpdate.push({
          // Index of this macro within the Cloud-storage walk order. Used as
          // ordinal fallback when macroId is null (older DC pages).
          cloudStorageIndex: i,
          macroId: cm.macroId,
          macroName: cm.macroName,
          sourceGroupNames: groupNames,
          sourceUserNames: userNames,
          groupIds: wantGroupIds,
          users: wantUsers,
          unresolvedGroups: groupRes.unresolved,
          unresolvedUsers: userRes.unresolved,
        });
      }

      if(macrosToUpdate.length===0) return;

      this.stats.pagesPlanned++;
      this.stats.macrosToUpdate += macrosToUpdate.length;
      planPages[id]={
        cloudPageId:id, dcPageId, spaceKey, title,
        contentType: storagePage.type||"page",
        macros: macrosToUpdate,
        status:"pending", error:null, updatedAt:null,
      };
    },this.opts.concurrency);

    const runId=String(Date.now());
    const plan={ version:"1.0", runId, createdAt:new Date().toISOString(),
      stats:{total:this.stats.pagesPlanned,pending:this.stats.pagesPlanned,completed:0,failed:0,skipped:0},
      pages: planPages };
    const planPath=path.join(this.logDir,`storage_plan_${runId}.json`);
    fs.writeFileSync(planPath,JSON.stringify(plan,null,2));
    this.log(`\nStorage plan saved: ${planPath}`);
    this.log(`  Pages with macros to update: ${this.stats.pagesPlanned}`);
    this.log(`  Total macros to update:      ${this.stats.macrosToUpdate}`);
    return planPath;
  }

  // ─── PHASE 2: EXECUTE ──────────────────────────────────────────────
  async executePlan(){
    if(!this.opts.planFile) throw new Error("--plan-file <path> is required");
    if(!fs.existsSync(this.opts.planFile)) throw new Error(`Plan not found: ${this.opts.planFile}`);
    this.log(`\nLoading storage plan ${this.opts.planFile}...`);
    const plan = JSON.parse(fs.readFileSync(this.opts.planFile,"utf8"));
    const pages = Object.values(plan.pages||{}).filter(p=>p.status==="pending"||p.status==="failed");
    this.log(`  Pages to process: ${pages.length}`);

    await this.runPool(pages,async(p)=>{
      try{ await this._executePage(p,plan); }
      catch(e){
        p.status="failed"; p.error=e.message; this.stats.pagesFailed++;
        this.log(`    "${p.title}" (Cloud: ${p.cloudPageId}): ERROR - ${e.message}`);
      }
    },this.opts.concurrency);

    plan.stats={ total:pages.length, pending:0,
      completed:this.stats.pagesUpdated, failed:this.stats.pagesFailed, skipped:this.stats.pagesSkipped };
    plan.completedAt=new Date().toISOString();
    fs.writeFileSync(this.opts.planFile, JSON.stringify(plan,null,2));
    this.log(`\nFinal:`);
    this.log(`  Pages updated: ${this.stats.pagesUpdated}`);
    this.log(`  Pages skipped: ${this.stats.pagesSkipped}`);
    this.log(`  Pages failed:  ${this.stats.pagesFailed}`);
    this.log(`  Macros updated: ${this.stats.macrosUpdated}`);
    this.log(`  Macros no-op:   ${this.stats.macrosNoChange}`);
  }

  async _executePage(p, plan){
    const id=p.cloudPageId;
    const sp=await this.cloudClient.getPageStorage(id);
    let v=sp.body?.storage?.value||"";
    if(!v) throw new Error("empty storage body");

    // Pre-compute per-Cloud-macro start positions for ordinal fallback.
    // Walks the same way extractDcParamsFromStorage does so the indexing matches.
    const cloudMacroStarts = (() => {
      const out=[];
      const allowed=new Set(["show-if","hide-if"]);
      const re=/<ac:structured-macro\b([^>]*)>/g;
      let mm;
      while((mm=re.exec(v))!==null){
        const nameMatch=mm[1].match(/ac:name\s*=\s*"([^"]+)"/);
        if(!nameMatch || !allowed.has(nameMatch[1])) continue;
        out.push(mm.index);
      }
      return out;
    })();

    let mutations=0;
    for(const m of p.macros){
      // Partial-resolution policy: write whatever IDs we DO have, leave
      // unresolved names alone. Only skip if NOTHING resolved at all.
      // Previously we skipped when any name was unresolved, which left
      // pages with one bad <ri:user> reference completely un-fixed even
      // though their group restrictions were resolvable.
      const hasAnything = !!m.groupIds || !!m.users;
      if(!hasAnything){ this.stats.macrosUnresolved++; continue; }

      // Find macro start in current storage. Prefer macroId; fall back to
      // ordinal cloudStorageIndex (DC pages without ac:macro-id).
      let macroStart=-1;
      if(m.macroId){
        const tagIdx = v.indexOf(`ac:macro-id="${m.macroId}"`);
        if(tagIdx!==-1){
          const MARKER="<ac:structured-macro";
          let s=tagIdx;
          while(s>0 && v.slice(s,s+MARKER.length)!==MARKER) s--;
          if(v.slice(s,s+MARKER.length)===MARKER) macroStart=s;
        }
      }
      if(macroStart===-1 && typeof m.cloudStorageIndex==="number" && m.cloudStorageIndex<cloudMacroStarts.length){
        macroStart = cloudMacroStarts[m.cloudStorageIndex];
      }
      if(macroStart===-1) continue;
      const tagEnd=v.indexOf(">",macroStart); if(tagEnd===-1) continue;

      // Find end of macro (closing </ac:structured-macro>)
      let depth=1, cur=tagEnd+1, end=-1;
      while(depth>0 && cur<v.length){
        const o=v.indexOf("<ac:structured-macro",cur);
        const c=v.indexOf("</ac:structured-macro>",cur);
        if(c===-1) break;
        if(o!==-1 && o<c){
          const oend=v.indexOf(">",o); if(oend===-1) break;
          if(v[oend-1]!=="/") depth++;
          cur=oend+1;
        } else {
          depth--;
          cur=c+22;
          if(depth===0) end=cur;
        }
      }
      if(end===-1) continue;

      // Region between header end and the macro end — this contains <ac:parameter>s and the rich-text-body
      // We want to insert/replace groupIds and users params before <ac:rich-text-body> (or before close tag if no body).
      const before = v.slice(0,tagEnd+1);
      let inner = v.slice(tagEnd+1, end - "</ac:structured-macro>".length);
      const after = v.slice(end - "</ac:structured-macro>".length);

      // Strip existing groupIds/users params at this macro's top level only.
      // Use a small helper that walks inner, removing those params at depth 0.
      inner = stripTopLevelParam(inner, "groupIds");
      inner = stripTopLevelParam(inner, "users");

      // Build replacement params
      const insertParts=[];
      if(m.groupIds) insertParts.push(`<ac:parameter ac:name="groupIds">${m.groupIds}</ac:parameter>`);
      if(m.users) insertParts.push(`<ac:parameter ac:name="users">${m.users}</ac:parameter>`);
      const insert = insertParts.join("");

      // Insert before <ac:rich-text-body> if present, else just before close.
      let newInner;
      const rtbIdx = inner.indexOf("<ac:rich-text-body>");
      if(rtbIdx!==-1){
        newInner = inner.slice(0,rtbIdx) + insert + inner.slice(rtbIdx);
      } else {
        // no body — append params at end of inner
        newInner = inner + insert;
      }

      v = before + newInner + after;
      mutations++;
    }

    if(mutations===0){
      p.status="skipped"; p.error="no-op"; p.updatedAt=new Date().toISOString();
      this.stats.pagesSkipped++; this.stats.macrosNoChange += (p.macros||[]).length;
      return;
    }

    if(this.opts.dryRun){
      this.stats.pagesUpdated++; this.stats.macrosUpdated+=mutations;
      this.log(`    [DRY RUN] "${p.title}" (Cloud: ${id}): would update ${mutations} macro(s)`);
      return;
    }

    const result = await this.cloudClient.updatePageStorage(
      id, sp.title, sp.type||p.contentType||"page", v, sp.version.number,
      "Visibility migration (storage path): inject groupIds/users into legacy-storage macros"
    );
    if(result.success){
      p.status="completed"; p.error=null; p.updatedAt=new Date().toISOString();
      this.stats.pagesUpdated++; this.stats.macrosUpdated+=mutations;
      this.log(`    "${p.title}" (Cloud: ${id}): updated ${mutations} macro(s)`);
    } else {
      p.status="failed"; p.error=result.error; this.stats.pagesFailed++;
      this.log(`    "${p.title}" (Cloud: ${id}): FAILED - ${result.error}`);
    }
  }

  async run(){
    await this.testConnections();
    if(this.opts.executeOnly) await this.executePlan();
    else if(this.opts.planOnly) await this.buildPlan();
    else throw new Error("Specify --plan-only or --execute-only");
  }
}

// Helper: strip a top-level <ac:parameter ac:name="..."> from inner XML, ignoring those nested deeper.
function stripTopLevelParam(inner, paramName){
  const out=[];
  let pos=0; let depth=0;
  while(pos<inner.length){
    if(depth===0){
      const nextOpen=inner.indexOf("<ac:structured-macro",pos);
      const nextParam=inner.indexOf("<ac:parameter",pos);
      // Whichever comes first
      if(nextParam!==-1 && (nextOpen===-1 || nextParam<nextOpen)){
        // Check if this is the param we want to strip
        const tagEnd=inner.indexOf(">",nextParam); if(tagEnd===-1){ out.push(inner.slice(pos)); break; }
        const header=inner.slice(nextParam,tagEnd+1);
        const isSelfClose=inner[tagEnd-1]==="/";
        const nameMatch=header.match(/ac:name\s*=\s*"([^"]+)"/);
        if(nameMatch && nameMatch[1]===paramName){
          // strip from nextParam to either /> end OR </ac:parameter>
          out.push(inner.slice(pos,nextParam));
          if(isSelfClose){ pos = tagEnd+1; }
          else { const close=inner.indexOf("</ac:parameter>",tagEnd+1); pos = close===-1 ? tagEnd+1 : close+"</ac:parameter>".length; }
          continue;
        } else {
          // keep it; copy up to and through this param
          const close=inner.indexOf("</ac:parameter>",tagEnd+1);
          if(isSelfClose){ pos = tagEnd+1; out.push(inner.slice(0)); break; }
          if(close===-1){ out.push(inner.slice(pos)); break; }
          out.push(inner.slice(pos,close+"</ac:parameter>".length)); pos=close+"</ac:parameter>".length;
        }
      } else if(nextOpen!==-1){
        // Skip over the nested structured-macro entirely, keep depth tracking
        out.push(inner.slice(pos,nextOpen));
        const oend=inner.indexOf(">",nextOpen); if(oend===-1){ out.push(inner.slice(nextOpen)); break; }
        if(inner[oend-1]==="/"){
          out.push(inner.slice(nextOpen,oend+1)); pos=oend+1;
        } else {
          depth=1; out.push(inner.slice(nextOpen,oend+1)); pos=oend+1;
        }
      } else {
        out.push(inner.slice(pos)); break;
      }
    } else {
      // inside a nested structured-macro — track depth but don't touch params
      const o=inner.indexOf("<ac:structured-macro",pos);
      const c=inner.indexOf("</ac:structured-macro>",pos);
      if(c===-1){ out.push(inner.slice(pos)); break; }
      if(o!==-1 && o<c){
        const oend=inner.indexOf(">",o); if(oend===-1){ out.push(inner.slice(pos)); break; }
        if(inner[oend-1]!=="/") depth++;
        out.push(inner.slice(pos,oend+1)); pos=oend+1;
      } else {
        depth--;
        out.push(inner.slice(pos,c+"</ac:structured-macro>".length)); pos=c+"</ac:structured-macro>".length;
      }
    }
  }
  return out.join("");
}

(async()=>{
  const opts=parseArgs(process.argv.slice(2));
  if(opts.help){ help(); process.exit(0); }
  if(!opts.planOnly && !opts.executeOnly){ help(); process.exit(1); }
  try{
    const r=new StorageSync(opts);
    await r.run();
    console.log("\nDone.");
  }catch(e){ console.error("\nFATAL:",e.message); if(process.env.DEBUG) console.error(e.stack); process.exit(1); }
})();
