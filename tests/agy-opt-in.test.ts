/**
 * Antigravity opt-in: default off even with an installed binary, strict parsing,
 * catalog and key gating, the same-origin status route, and CLI-billed reporting.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings, providerKeyMissing, isProviderKeyRefusal } = await import("../src/core/settings.ts");
const { parseAgySettingsBody } = await import("../src/server/settings-body.ts");
const { agyAvailable, agyEnabled } = await import("../src/server/agy-config.ts");
const { agyInstallationResponse } = await import("../src/server/agy.ts");
const { catalogContextLimits, catalogProviders, modelCatalog } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { sideContextWindow } = await import("../src/server/side-context-budget.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

/** An executable-looking `agy` first on PATH; discovery only checks the marker, nothing runs it. */
function setup(t: TestContext) {
	const previous = readSettings();
	const path = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "agy-opt-in-"));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}

async function save(body: unknown) {
	return PUT(new Request("http://test/api/settings/agy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ section: "agy" }) });
}

test("opt-in parses strictly and malformed stored values never enable the CLI", () => {
	assert.deepEqual(parseAgySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAgySettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseAgySettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [true, null, [], "on", { enabled: "true" }, { enabled: 1 }]) assert.equal(parseAgySettingsBody(raw).ok, false);
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, agy: raw })?.agy?.enabled, true);
	}
	assert.equal(sanitizeUserSettings({ version: 1 })?.agy, undefined);
});

test("default off with an installed binary; the section toggles availability and keeps unrelated settings", async (t) => {
	setup(t);
	writeSettings({ version: 1, graph: { enabled: false }, futureSection: { keep: 1 } });
	assert.equal(agyEnabled(), false); assert.equal(agyAvailable(), false);
	assert.equal(providerKeyPresent("agy"), false);
	assert(!modelCatalog().models.some((m) => m.provider === "agy"));
	assert.deepEqual(catalogProviders().find((p) => p.id === "agy"), { id: "agy", envVar: "", keyPresent: false });

	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(agyEnabled(), true); assert.equal(agyAvailable(), true);
	assert.equal(providerKeyPresent("agy"), true);
	assert.deepEqual(catalogProviders().find((p) => p.id === "agy"), { id: "agy", envVar: "", keyPresent: true });
	const settings = readSettings() as Record<string, unknown>;
	assert.deepEqual(settings.graph, { enabled: false });
	assert.deepEqual(settings.futureSection, { keep: 1 });

	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(agyAvailable(), false);
	assert.equal((await save({ enabled: "yes" })).status, 400);
});

test("enabled without a binary is unavailable", async (t) => {
	setup(t);
	const path = process.env.PATH;
	process.env.PATH = "";
	const home = process.env.HOME;
	process.env.HOME = testData;
	t.after(() => { process.env.PATH = path; if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
	await save({ enabled: true });
	// Known directories (/opt/homebrew/bin, /usr/local/bin) may hold a real agy on the machine running the suite.
	if (!agyAvailable()) assert.equal(providerKeyPresent("agy"), false);
	assert.equal(agyEnabled(), true);
});

test("the catalog lists agy models unpriced and without placeholder limits when enabled", async (t) => {
	setup(t);
	await save({ enabled: true });
	const models = modelCatalog().models.filter((m) => m.provider === "agy");
	// The picker sorts alphabetically.
	assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gemini-4-argon", "gpt-oss-120b"]);
	for (const m of models) { assert.equal(m.cost, null); assert.equal(m.contextWindow, null); assert.equal(m.maxTokens, null); assert.deepEqual(m.input, ["text"]); }
	assert.deepEqual(models.find((m) => m.id === "claude-opus-5-5")?.supportedLevels, ["low", "medium", "high"]);
	assert.deepEqual(models.find((m) => m.id === "gpt-oss-120b")?.supportedLevels, ["medium"]);
	assert.equal(catalogContextLimits().has("agy:gemini-4-argon"), false);
});

test("agy is never priced and never has a side-chat window", () => {
	assert.equal(callCost({ inputTokens: 1000, outputTokens: 1000 }, "agy:claude-opus-5-5"), null);
	assert.equal(sideContextWindow([], { provider: "agy", id: "gemini-4-argon" }, 1_000_000, false), undefined);
});

test("a missing opt-in refuses with the Antigravity wording the UI treats as info", () => {
	const missing = providerKeyMissing("agy", ["strong"]);
	assert.match(missing.error, /^Antigravity is unavailable/);
	assert.equal(isProviderKeyRefusal(missing.error), true);
});

test("the status route needs the same-origin intent header and the opt-in", async () => {
	const status = { state: "meets-minimum" as const, version: "1.5.6", minimumVersion: "1.5.0" };
	const request = (headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/agy", { headers: { "x-learnharness-agy": "1", ...headers } });
	let probes = 0;
	const inspect = async () => { probes++; return status; };

	for (const headers of [{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }, { "x-learnharness-agy": "" }] as Record<string, string>[]) {
		assert.equal((await agyInstallationResponse(request(headers), inspect, () => true)).status, 403);
	}
	assert.equal((await agyInstallationResponse(new Request("http://localhost:3000/api/agy"), inspect, () => true)).status, 403);
	assert.equal((await agyInstallationResponse(request(), inspect, () => false)).status, 403);
	assert.equal(probes, 0);

	const ok = await agyInstallationResponse(request(), inspect, () => true);
	assert.equal(ok.status, 200); assert.equal(probes, 1);
	assert.equal(ok.headers.get("cache-control"), "no-store");
	assert.deepEqual(await ok.json(), status);
});
