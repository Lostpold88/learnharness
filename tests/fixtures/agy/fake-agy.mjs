/**
 * Stand-in for the agy CLI in tests. Reads the first stream-json line from
 * stdin, then replays the scenario file named by FAKE_AGY_SCENARIO line by
 * line. Lines with a "fake" key are directives instead of output:
 *   {"fake":"hold"}                                  stay alive until killed, like the CLI waiting on a held MCP call
 *   {"fake":"exit","code":1,"stderr":"..."}          write stderr and exit with that code
 *   {"fake":"call","step":2,"name":"read","arguments":{}}        call the MCP bridge (progressToken "run:<step>") and wait for its result
 *   {"fake":"start-call",...}                        start the same request without waiting for its result
 *   {"fake":"reply","step":5}                        stream one agent_response step whose text is every result so far, joined by " | "
 * FAKE_AGY_STDIN receives the stdin line; FAKE_AGY_TOOLS receives the bridge's tools/list.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HOLD_INTERVAL_MS = 60_000;

const writeLine = (line) => new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
const step = (index, state, extra = {}) => JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv", step_index: index, state, ...extra } });

const mcpConfig = readFileSync(".agents/mcp_config.json", "utf8");
let received;
const userReceived = new Promise((resolve) => { received = resolve; });
createInterface({ input: process.stdin }).on("line", (line) => {
	if (process.env.FAKE_AGY_STDIN) writeFileSync(process.env.FAKE_AGY_STDIN, `${line}\n`);
	received();
});
await userReceived;

let bridge = null;
const results = [];
const pending = [];
const lines = readFileSync(process.env.FAKE_AGY_SCENARIO, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
	const directive = JSON.parse(line);
	if (directive.fake === "hold") { setInterval(() => {}, HOLD_INTERVAL_MS); break; }
	if (directive.fake === "exit") { process.stderr.write(directive.stderr ?? ""); process.exit(directive.code); }
	if (directive.fake === "call" || directive.fake === "start-call") {
		if (!bridge) {
			const { url, headers } = JSON.parse(mcpConfig).mcpServers.learnharness;
			bridge = new Client({ name: "fake-agy", version: "1.0.0" });
			await bridge.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
			if (process.env.FAKE_AGY_TOOLS) writeFileSync(process.env.FAKE_AGY_TOOLS, JSON.stringify(await bridge.listTools()));
		}
		const request = bridge.callTool({ name: directive.name, arguments: directive.arguments, _meta: { progressToken: `run:${directive.step}` } });
		if (directive.fake === "start-call") { pending.push(request); void request.catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 5)); }
		else results.push((await request).content.map((block) => block.text).join(""));
		continue;
	}
	if (directive.fake === "reply") {
		for (const result of await Promise.all(pending.splice(0))) results.push(result.content.map((block) => block.text).join(""));
		await writeLine(step(directive.step, "DONE", { step_type: "agent_response", text_delta: results.join(" | "), usage: { input_tokens: 5, output_tokens: 2 } }));
		continue;
	}
	await writeLine(line);
}
