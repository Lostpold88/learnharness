import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AgyInstallationStatus } from "../components/settings/agy-status.tsx";
import type { AgyStatus } from "../src/core/contracts/agy.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: AgyStatus["state"], version: string | null = null): AgyStatus => ({ state, version, minimumVersion: "1.5.0" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="agy-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;

function fixture(probe: () => Promise<Response>, enabled = true) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, agy: { enabled: on } } });
		if (url === "/api/settings/agy") {
			assert.equal(init?.method, "PUT");
			on = JSON.parse(String(init?.body)).enabled;
			return Response.json({ settings: { version: 1, agy: { enabled: on } } });
		}
		assert.equal(url, "/api/agy");
		assert.equal(init?.cache, "no-store");
		assert.equal(new Headers(init?.headers).get("x-learnharness-agy"), "1");
		return probe();
	}) as typeof fetch;
	return calls;
}

async function mount() {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<AgyInstallationStatus />));
}

afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("initial render is collapsed and off", () => {
	const html = renderToStaticMarkup(<AgyInstallationStatus />);
	assert.match(html, /Antigravity/); assert.match(html, /aria-checked="false"/);
	assert(!html.includes("Check again"));
});

test("enabling persists before probing, then shows the version and the text-only notice", async () => {
	const calls = fixture(async () => Response.json(status("meets-minimum", "1.5.6")), false);
	await mount();
	assert(!button()); assert.deepEqual(calls, ["GET /api/settings"]);
	await act(async () => toggle().click());
	assert.equal(label(), "Version 1.5.6 · meets minimum");
	assert(calls.indexOf("PUT /api/settings/agy") < calls.indexOf("GET /api/agy"));
	assert.match(document.body.textContent ?? "", /Antigravity controls billing/);
	assert.match(document.body.textContent ?? "", /Text only/);
	assert.match(document.body.textContent ?? "", /Requires v1\.5\.0\+/);
});

test("an enabled record probes immediately and Check again re-probes", async () => {
	const calls = fixture(async () => Response.json(status("update-required", "1.4.0")));
	await mount();
	assert.equal(label(), "Version 1.4.0 · update required");
	await act(async () => button().click());
	assert.equal(calls.filter((call) => call === "GET /api/agy").length, 2);
});

test("an invalid status response degrades to the unchecked label", async () => {
	fixture(async () => Response.json({ state: "meets-minimum", version: "1.5.6; rm -rf", minimumVersion: "1.5.0" }));
	await mount();
	assert.equal(label(), "Version could not be checked");
});

test("disabling hides the status row", async () => {
	fixture(async () => Response.json(status("not-found")));
	await mount();
	assert.equal(label(), "Not found");
	await act(async () => toggle().click());
	assert(!button());
});
