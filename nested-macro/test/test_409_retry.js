#!/usr/bin/env node

/**
 * Integration test for the 409 (version conflict) retry path in
 * NestedMacroSync.processOne.
 *
 * What we're guarding against: the OLD behaviour silently re-PUT the
 * cached, stale `newStorageBody` after a 409, overwriting any concurrent
 * edit. The fixed behaviour is: refetch the page, re-detect, re-un-nest
 * against the FRESH storage, then PUT — so the concurrent editor's bytes
 * are preserved (and our un-nesting is applied on top).
 *
 * Strategy: mock CloudConfluenceClient to script a sequence of GET/PUT
 * responses including a 409, then drive processOne and assert the second
 * PUT carries content derived from the SECOND (post-edit) GET, not the
 * first.
 */

const assert = require("assert");

const NestedMacroSync = require("../main/sync_nested_macros");

let passes = 0;
let failures = 0;
const failureDetails = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  OK    ${name}`);
      passes++;
    })
    .catch((err) => {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
      failures++;
      failureDetails.push({ name, err });
    });
}

// ─── Mock helpers ────────────────────────────────────────────────────

class MockCloudClient {
  constructor(script) {
    this.script = script; // { gets: [storageString, ...], puts: [{statusCode?, success}, ...] }
    this.getCalls = 0;
    this.putCalls = 0;
    this.putPayloads = [];
  }
  async testConnection() { return true; }
  async getPageWithStorage(pageId) {
    const storage = this.script.gets[this.getCalls];
    this.getCalls++;
    return {
      id: String(pageId),
      title: "Mock Page",
      version: { number: this.getCalls }, // simulate version bumping per fetch
      body: { storage: { value: storage, representation: "storage" } },
    };
  }
  async updatePageStorage(pageId, title, body, currentVersion) {
    const idx = this.putCalls;
    const scripted = this.script.puts[idx] || { success: true };
    this.putCalls++;
    this.putPayloads.push({ pageId, title, body, currentVersion });
    if (scripted.statusCode === 409) {
      return { success: false, statusCode: 409, error: "Mock 409" };
    }
    if (scripted.statusCode && scripted.statusCode >= 400) {
      return { success: false, statusCode: scripted.statusCode, error: `Mock ${scripted.statusCode}` };
    }
    return { success: true, error: null };
  }
  getStats() { return { requestCount: this.getCalls + this.putCalls, errorCount: 0, rateLimitCount: 0 }; }
}

class MockPlanManager {
  constructor() {
    this.statuses = new Map();
    this.plan = { stats: { pending: 1 } };
    this.planFilePath = "/tmp/mock-plan.json";
  }
  setPlanFile() {}
  loadPlan() { return this.plan; }
  savePlan() {}
  updatePageStatus(pageId, status, extras = {}) {
    this.statuses.set(pageId, { status, ...extras });
  }
}

function buildSync(client, planManager) {
  // Build a NestedMacroSync without the constructor's env validation by
  // bypassing it (the constructor needs CLOUD_BASE_URL etc — set fake
  // ones temporarily).
  process.env.CLOUD_BASE_URL = process.env.CLOUD_BASE_URL || "https://mock.test";
  process.env.CLOUD_EMAIL = process.env.CLOUD_EMAIL || "mock@test";
  process.env.CLOUD_API_TOKEN = process.env.CLOUD_API_TOKEN || "mocktoken";

  const sync = new NestedMacroSync({
    spaceKeys: ["MOCK"],
    dryRun: false,
  });
  // Replace the real client + plan manager with our mocks
  sync.cloudClient = client;
  sync.planManager = planManager;
  // Quiet the per-line logger
  sync.log = () => {};
  return sync;
}

// ─── Fixtures ────────────────────────────────────────────────────────

const NESTED = (innerText) =>
  '<ac:structured-macro ac:name="info" ac:macro-id="o"><ac:rich-text-body>' +
  `<p>${innerText}</p>` +
  '<ac:structured-macro ac:name="panel" ac:macro-id="i"><ac:rich-text-body><p>P</p></ac:rich-text-body></ac:structured-macro>' +
  "<p>tail</p>" +
  "</ac:rich-text-body></ac:structured-macro>";

const FLAT = "<p>nothing nested here anymore</p>";

// ─── Tests ───────────────────────────────────────────────────────────

console.log("\n--- 409 retry semantics ---\n");

async function run() {
  await test("happy path: single PUT, no retry, succeeds", async () => {
    const client = new MockCloudClient({
      gets: [NESTED("first")],
      puts: [{ success: true }],
    });
    const pm = new MockPlanManager();
    const sync = buildSync(client, pm);
    await sync.processOne("page1", { beforeHash: "x" }, 1, 1);
    assert.strictEqual(client.getCalls, 1, "exactly one GET");
    assert.strictEqual(client.putCalls, 1, "exactly one PUT");
    assert.strictEqual(pm.statuses.get("page1").status, "completed");
  });

  await test("409 once, then 200 — refetches and re-derives PUT body from FRESH storage", async () => {
    // First GET: original nested. Second GET (after 409): edited content
    // where someone added "EDITED!" prefix. The second PUT body MUST contain
    // "EDITED!" — proving we re-derived from fresh storage, not reused the
    // stale first-PUT body.
    const editedNested = NESTED("EDITED!");
    const client = new MockCloudClient({
      gets: [NESTED("first"), editedNested],
      puts: [{ statusCode: 409 }, { success: true }],
    });
    const pm = new MockPlanManager();
    const sync = buildSync(client, pm);
    await sync.processOne("page1", { beforeHash: "x" }, 1, 1);

    assert.strictEqual(client.getCalls, 2, "exactly two GETs (refetch on 409)");
    assert.strictEqual(client.putCalls, 2, "exactly two PUTs (retry after 409)");

    // The decisive assertion: second PUT body must reflect the edited
    // content, not the first-fetch content.
    const secondPutBody = client.putPayloads[1].body;
    assert.ok(
      secondPutBody.includes("EDITED!"),
      `Second PUT must reflect post-edit GET (concurrent editor preserved). Got: ${secondPutBody.slice(0, 200)}`,
    );
    assert.ok(
      !secondPutBody.includes(">first<"),
      `Second PUT must NOT carry the stale first-fetch body. Got: ${secondPutBody.slice(0, 200)}`,
    );
    // And it must use the fresh version number (2, since version bumps per GET in the mock)
    assert.strictEqual(client.putPayloads[1].currentVersion, 2, "PUT must use fresh version");
    assert.strictEqual(pm.statuses.get("page1").status, "completed");
  });

  await test("409 twice, then 200 — succeeds inside the 2-attempt budget", async () => {
    const client = new MockCloudClient({
      gets: [NESTED("g1"), NESTED("g2"), NESTED("g3")],
      puts: [{ statusCode: 409 }, { statusCode: 409 }, { success: true }],
    });
    const pm = new MockPlanManager();
    const sync = buildSync(client, pm);
    await sync.processOne("page1", { beforeHash: "x" }, 1, 1);

    assert.strictEqual(client.getCalls, 3);
    assert.strictEqual(client.putCalls, 3);
    assert.strictEqual(pm.statuses.get("page1").status, "completed");
  });

  await test("409 three times — exhausts budget and fails (no silent overwrite)", async () => {
    const client = new MockCloudClient({
      gets: [NESTED("g1"), NESTED("g2"), NESTED("g3")],
      puts: [{ statusCode: 409 }, { statusCode: 409 }, { statusCode: 409 }],
    });
    const pm = new MockPlanManager();
    const sync = buildSync(client, pm);
    await sync.processOne("page1", { beforeHash: "x" }, 1, 1);

    // 1 initial + 2 retries = 3 PUTs total
    assert.strictEqual(client.putCalls, 3, "exactly 3 PUTs (1 + 2 retries)");
    assert.strictEqual(pm.statuses.get("page1").status, "failed");
  });

  await test("refetch after 409 returns now-clean storage — marks skipped, no PUT", async () => {
    // First GET nested. First PUT 409. Second GET: someone manually fixed
    // the page (no nestings). We must NOT PUT anything; mark skipped.
    const client = new MockCloudClient({
      gets: [NESTED("first"), FLAT],
      puts: [{ statusCode: 409 }],
    });
    const pm = new MockPlanManager();
    const sync = buildSync(client, pm);
    await sync.processOne("page1", { beforeHash: "x" }, 1, 1);

    assert.strictEqual(client.getCalls, 2);
    assert.strictEqual(client.putCalls, 1, "no second PUT — concurrent editor already fixed it");
    assert.strictEqual(pm.statuses.get("page1").status, "skipped");
  });

  await test("non-409 PUT failure — fails immediately, no retry", async () => {
    const client = new MockCloudClient({
      gets: [NESTED("first")],
      puts: [{ statusCode: 500 }],
    });
    const pm = new MockPlanManager();
    const sync = buildSync(client, pm);
    await sync.processOne("page1", { beforeHash: "x" }, 1, 1);

    assert.strictEqual(client.putCalls, 1, "no retry on non-409");
    assert.strictEqual(pm.statuses.get("page1").status, "failed");
  });

  console.log(`\n${passes} passed, ${failures} failed.\n`);
  if (failures > 0) {
    console.log("Failure details:");
    for (const { name, err } of failureDetails) {
      console.log(`  ${name}:\n    ${err.stack || err.message}`);
    }
    process.exit(1);
  }
}

run();
