const fs = require("fs");
const path = require("path");

class PlanManager {
  constructor(planDir, log) {
    this.planDir = planDir;
    this.log = log || console.log;
    this.plan = null;
    this.planFilePath = null;
    this.updatesSinceSave = 0;
    this.autoSaveThreshold = 50;
  }

  setPlanFile(filePath) {
    this.planFilePath = filePath;
  }

  // ─────────────────────────────────────────────────
  //  PLAN CREATION
  // ─────────────────────────────────────────────────

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
      stats: { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      pages: {},
    };

    this.savePlan();
    return this.plan;
  }

  addPageToPlan(dcPageId, data) {
    if (!this.plan) return;

    this.plan.pages[dcPageId] = {
      status: "pending",
      spaceKey: data.spaceKey,
      title: data.title,
      dcPageId: String(dcPageId),
      cloudPageId: data.cloudPageId ? String(data.cloudPageId) : null,
      htmlMacros: data.htmlMacros || [],
      cssMacros: data.cssMacros || [],
      macroCount: (data.htmlMacros ? data.htmlMacros.length : 0) + (data.cssMacros ? data.cssMacros.length : 0),
      error: null,
      updatedAt: null,
    };

    this.plan.stats.total++;
    this.plan.stats.pending++;
    this.plan.updatedAt = new Date().toISOString();

    this.updatesSinceSave++;
    if (this.updatesSinceSave >= this.autoSaveThreshold) {
      this.savePlan();
    }
  }

  // ─────────────────────────────────────────────────
  //  PLAN PERSISTENCE
  // ─────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────
  //  STATUS TRACKING
  // ─────────────────────────────────────────────────

  getPagesToProcess(retryFailed) {
    if (!this.plan) return [];
    return Object.entries(this.plan.pages).filter(
      ([, data]) => data.status === "pending" || (retryFailed && data.status === "failed"),
    );
  }

  updatePageStatus(dcPageId, status, error = null) {
    if (!this.plan || !this.plan.pages[dcPageId]) return;

    this.plan.pages[dcPageId].status = status;
    this.plan.pages[dcPageId].error = error;
    this.plan.pages[dcPageId].updatedAt = new Date().toISOString();

    this.updatesSinceSave++;
    if (this.updatesSinceSave >= this.autoSaveThreshold) {
      this.savePlan();
    }
  }

  recalculateStats() {
    if (!this.plan) return;

    const stats = { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 };

    for (const page of Object.values(this.plan.pages)) {
      stats.total++;
      if (stats[page.status] !== undefined) {
        stats[page.status]++;
      }
    }

    this.plan.stats = stats;
  }

  formatStats() {
    if (!this.plan) return "No plan loaded";
    const s = this.plan.stats;
    return `${s.total} pages (${s.pending} pending, ${s.completed} completed, ${s.failed} failed, ${s.skipped} skipped)`;
  }

  getPlanSummary() {
    if (this.plan) {
      return {
        ...this.plan.stats,
        planFile: this.planFilePath,
      };
    }
    return null;
  }
}

module.exports = PlanManager;
