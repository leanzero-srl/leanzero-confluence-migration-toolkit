const fs = require("fs");
const path = require("path");

/**
 * Plan persistence for the nested-macro un-nester.
 *
 * Plan shape:
 *   {
 *     version: "1.0",
 *     runId: <string>,
 *     createdAt, updatedAt,
 *     stats: { total, pending, completed, failed, skipped, unfixable },
 *     totals: { nestedFound, fixable, excluded, unfixable },
 *     pages: {
 *       <pageId>: {
 *         status: "pending"|"completed"|"failed"|"skipped"|"unfixable",
 *         title, spaceKey, version,
 *         nestings: [{outerMacro, innerMacro, depth, strategy, path}],
 *         beforeHash, afterHash, error, updatedAt
 *       }
 *     }
 *   }
 *
 * Adapted from confluence/html-macro/src/planManager.js.
 */
class PlanManager {
  constructor(planDir, log) {
    this.planDir = planDir;
    this.log = log || console.log;
    this.plan = null;
    this.planFilePath = null;
    this.updatesSinceSave = 0;
    // Higher threshold keeps bulk runs fast — plan file can be large (>400MB
    // for tenant-wide scans) so re-serialising every 50 updates becomes a
    // bottleneck. SIGINT still forces a final save before exit.
    this.autoSaveThreshold = parseInt(process.env.PLAN_AUTOSAVE_EVERY || "500", 10);
  }

  setPlanFile(filePath) {
    this.planFilePath = filePath;
  }

  createPlan(runId) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }

    this.planFilePath = path.join(this.planDir, `plan_${runId}.json`);
    this.plan = {
      version: "1.0",
      runId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0, unfixable: 0 },
      totals: { nestedFound: 0, fixable: 0, excluded: 0, unfixable: 0 },
      pages: {},
    };

    this.savePlan();
    return this.plan;
  }

  addPageToPlan(pageId, data) {
    if (!this.plan) return;

    this.plan.pages[pageId] = {
      status: data.status || "pending",
      pageId: String(pageId),
      spaceKey: data.spaceKey,
      title: data.title,
      version: data.version,
      nestings: data.nestings || [],
      beforeHash: data.beforeHash || null,
      afterHash: null,
      error: null,
      updatedAt: null,
    };

    this.plan.stats.total++;
    const status = data.status || "pending";
    if (this.plan.stats[status] !== undefined) this.plan.stats[status]++;
    this.plan.totals.nestedFound += (data.nestings || []).length;
    this.plan.updatedAt = new Date().toISOString();

    this.updatesSinceSave++;
    if (this.updatesSinceSave >= this.autoSaveThreshold) this.savePlan();
  }

  savePlan() {
    if (!this.plan || !this.planFilePath) return;

    this.plan.updatedAt = new Date().toISOString();
    this.recalculateStats();

    this._streamWritePlan(this.planFilePath, this.plan);
    this.updatesSinceSave = 0;
  }

  _streamWritePlan(filePath, plan) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, "{\n");
      fs.writeSync(fd, `"version":${JSON.stringify(plan.version)},\n`);
      fs.writeSync(fd, `"runId":${JSON.stringify(plan.runId)},\n`);
      fs.writeSync(fd, `"createdAt":${JSON.stringify(plan.createdAt)},\n`);
      fs.writeSync(fd, `"updatedAt":${JSON.stringify(plan.updatedAt)},\n`);
      fs.writeSync(fd, `"stats":${JSON.stringify(plan.stats)},\n`);
      fs.writeSync(fd, `"totals":${JSON.stringify(plan.totals)},\n`);
      fs.writeSync(fd, `"pages":{\n`);

      const pageIds = Object.keys(plan.pages);
      for (let i = 0; i < pageIds.length; i++) {
        const key = pageIds[i];
        const comma = i < pageIds.length - 1 ? ",\n" : "\n";
        fs.writeSync(fd, `${JSON.stringify(key)}:${JSON.stringify(plan.pages[key])}${comma}`);
      }

      fs.writeSync(fd, "}\n}");
    } catch (error) {
      this.log(`  ERROR saving plan: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  loadPlan(filePath) {
    const target = filePath || this.planFilePath;
    if (!target) {
      this.log("  No plan file specified, searching for latest...");
      const latest = this.findLatestPlan();
      if (!latest) {
        this.log("  No existing plan found.");
        return null;
      }
      this.planFilePath = latest;
    } else {
      this.planFilePath = target;
    }

    if (!fs.existsSync(this.planFilePath)) {
      this.log(`  Plan not found: ${this.planFilePath}`);
      return null;
    }

    try {
      this.log(`  Loading plan from ${this.planFilePath}...`);
      const data = fs.readFileSync(this.planFilePath, "utf8");
      const parsed = JSON.parse(data);
      this.plan = parsed;
      // Backfill any new keys if loading an older plan.
      if (!this.plan.totals) {
        this.plan.totals = { nestedFound: 0, fixable: 0, excluded: 0, unfixable: 0 };
      }
      this.recalculateStats();
      this.log(`  Loaded plan: ${this.formatStats()}`);
      return this.plan;
    } catch (error) {
      this.log(`  ERROR loading plan: ${error.message}`);
      return null;
    }
  }

  findLatestPlan() {
    if (!fs.existsSync(this.planDir)) return null;
    const files = fs.readdirSync(this.planDir)
      .filter((f) => f.startsWith("plan_") && f.endsWith(".json"))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(this.planDir, files[0]) : null;
  }

  getPagesToProcess(retryFailed) {
    if (!this.plan) return [];
    return Object.entries(this.plan.pages).filter(
      ([, d]) => d.status === "pending" || (retryFailed && d.status === "failed"),
    );
  }

  updatePageStatus(pageId, status, extras = {}) {
    if (!this.plan || !this.plan.pages[pageId]) return;
    const page = this.plan.pages[pageId];
    page.status = status;
    if ("error" in extras) page.error = extras.error;
    if ("afterHash" in extras) page.afterHash = extras.afterHash;
    if ("version" in extras) page.version = extras.version;
    page.updatedAt = new Date().toISOString();

    this.updatesSinceSave++;
    if (this.updatesSinceSave >= this.autoSaveThreshold) this.savePlan();
  }

  recalculateStats() {
    if (!this.plan) return;
    const stats = { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0, unfixable: 0 };
    for (const page of Object.values(this.plan.pages)) {
      stats.total++;
      if (stats[page.status] !== undefined) stats[page.status]++;
    }
    this.plan.stats = stats;
  }

  formatStats() {
    if (!this.plan) return "No plan loaded";
    const s = this.plan.stats;
    return `${s.total} pages (${s.pending} pending, ${s.completed} completed, ${s.failed} failed, ${s.skipped} skipped, ${s.unfixable} unfixable)`;
  }

  getPlanSummary() {
    if (!this.plan) return null;
    return { ...this.plan.stats, totals: this.plan.totals, planFile: this.planFilePath };
  }
}

module.exports = PlanManager;
