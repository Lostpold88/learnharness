/**
 * agy stream function (src/agent/agy/stream.ts), event parser, launch args,
 * binary/installation lookup, provider catalog and the bridge profile.
 *
 * The runAgy seam spawns tests/fixtures/agy/fake-agy.mjs, which replays
 * synthetic stream-json lines and calls the real loopback MCP bridge, so the
 * process plumbing (argv, cwd files, stdin, stdout lines, exit, kill) runs end to end.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, Message, SimpleStreamOptions, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createToolBridge } from "../src/agent/claude-code/tool-bridge.ts";
import { AGY_BRIDGE_PROFILE } from "../src/agent/agy/bridge.ts";
import { resolveAgyBinary } from "../src/agent/agy/binary.ts";
import { parseAgyLine } from "../src/agent/agy/cli-events.ts";
import { AgyError } from "../src/agent/agy/constants.ts";
import { inspectAgyInstallation } from "../src/agent/agy/installation.ts";
import { AGY_MODELS } from "../src/agent/agy/provider.ts";
import { createAgyStreamFunction, toAgyArgs, toAgyEffort, type RunAgy } from "../src/agent/agy/stream.ts";
import { toStreamJsonLine } from "../src/agent/agy/transcript.ts";
import { AGY_MINIMUM_VERSION } from "../src/core/contracts/agy.ts";

const FAKE_AGY = fileURLToPath(new URL("./fixtures/agy/fake-agy.mjs", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const SESSION_ID = "agy-stream-test";
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

const step = (index: number, state: string, extra: object = {}) =>
	JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv", step_index: index, state, ...extra } });
const agentStep = (index: number, state: string, extra: object = {}) => step(index, state, { step_type: "agent_response", ...extra });
const result = (extra: object = {}) => JSON.stringify({ event: "result", result: { conversation_id: "conv", status: "SUCCESS", ...extra } });
const call = (stepIndex: number, name = "read", args: object = {}) => JSON.stringify({ fake: "call", step: stepIndex, name, arguments: args });

type Spawn = { args: string[]; cwd: string; agentFile: string; mcpConfig: string; mcpConfigMode: number; tools: string; stdinFile: string; child: ChildProcessWithoutNullStreams };

function createFakeRun(t: TestContext, scenario: string[]): { runAgy: RunAgy; spawns: Spawn[] } {
	const dir = mkdtempSync(join(tmpdir(), "agy-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);
	const spawns: Spawn[] = [];
	const runAgy: RunAgy = (args, options) => {
		const index = spawns.length;
		const stdinFile = join(dir, `stdin-${index}`);
		const tools = join(dir, `tools-${index}.json`);
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile, FAKE_AGY_STDIN: stdinFile, FAKE_AGY_TOOLS: tools },
			stdio: "pipe",
		});
		t.after(() => child.kill("SIGKILL"));
		spawns.push({
			args,
			cwd: options.cwd,
			agentFile: readFileSync(join(options.cwd, ".agents/agents/learnharness.md"), "utf8"),
			mcpConfig: readFileSync(join(options.cwd, ".agents/mcp_config.json"), "utf8"),
			mcpConfigMode: statSync(join(options.cwd, ".agents/mcp_config.json")).mode & 0o777,
			tools,
			stdinFile,
			child,
		});
		return child;
	};
	return { runAgy, spawns };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function model(id = "gemini-3.8-flash") {
	const found = AGY_MODELS.find((candidate) => candidate.id === id);
	assert.ok(found);
	return found;
}

function turn(streamFn: ReturnType<typeof createAgyStreamFunction>, messages: Message[], options?: SimpleStreamOptions) {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });
	return collect(streamFn(model(), context, { sessionId: SESSION_ID, ...options }));
}

const HI: Message = { role: "user", content: "hi", timestamp: 0 };

function last(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const event = events.at(-1);
	assert.ok(event);
	return event;
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const event = last(events);
	assert.ok(event.type === "done", `turn ended with ${event.type}`);
	return event.message;
}

const text = (message: AssistantMessage) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(2000) }), "agy CLI process was not killed");
}

async function waitForRemoval(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (existsSync(path) && Date.now() < deadline) await sleep(20);
	assert.equal(existsSync(path), false, `${path} was not removed`);
}

test("streams a plain text turn, sends the stdin line and writes agent and MCP files", async (t) => {
	const { runAgy, spawns } = createFakeRun(t, [
		JSON.stringify({ event: "init", conversation_id: "conv", init: {} }),
		agentStep(1, "ACTIVE", { text_delta: "Hel" }),
		agentStep(1, "DONE", { text_delta: "lo", usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 2 } }),
		result({ response: "Hello" }),
	]);
	const events = await turn(createAgyStreamFunction(runAgy), [HI], { reasoning: "high" });
	const message = doneMessage(events);

	assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	assert.equal(text(message), "Hello");
	assert.equal(message.stopReason, "stop");
	assert.deepEqual([message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.totalTokens], [10, 3, 2, 15]);

	const [run] = spawns;
	assert.ok(run);
	assert.deepEqual(run.args, ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.8-flash", "--effort", "high", "--agent", "learnharness"]);
	assert.deepEqual(JSON.parse(readFileSync(run.stdinFile, "utf8")), { event: "user", message: { role: "user", content: "hi" } });
	assert.match(run.agentFile, /^---\nname: learnharness\n[\s\S]*excludeDefaultComponents: true\ninheritCustomizations: false\n---\nYou are a tutor\.\n$/);
	assert.equal(run.mcpConfigMode, 0o600);
	await waitForExit(run.child);
	await waitForRemoval(run.cwd);
});

test("advertises bridge tools for eager loading and a held call timeout in the MCP config", async (t) => {
	const { runAgy, spawns } = createFakeRun(t, [call(2), HOLD]);
	const events = await turn(createAgyStreamFunction(runAgy), [HI]);
	assert.equal(doneMessage(events).stopReason, "toolUse");

	const [run] = spawns;
	assert.ok(run);
	const config = JSON.parse(run.mcpConfig) as { mcpServers: Record<string, { url: string; headers: { Authorization: string }; timeoutSeconds: number }> };
	assert.match(config.mcpServers.learnharness?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.match(config.mcpServers.learnharness?.headers.Authorization ?? "", /^Bearer [0-9a-f]{64}$/);
	assert.equal(config.mcpServers.learnharness?.timeoutSeconds, 1800);
	const listed = JSON.parse(readFileSync(run.tools, "utf8")) as { tools: { name: string; _meta?: object }[] };
	assert.deepEqual(listed.tools.map((tool) => [tool.name, tool._meta]), [["read", { "antigravity/alwaysLoad": true }]]);
});

test("a held tool call ends the message with toolUse and the result continues the same process", async (t) => {
	const { runAgy, spawns } = createFakeRun(t, [
		agentStep(1, "DONE", { text_delta: "Let me look.", usage: { input_tokens: 4, output_tokens: 1 } }),
		step(2, "ACTIVE", { step_type: "tool", tool_name: "mcp_learnharness_read" }),
		call(2, "read", { path: "a.txt" }),
		JSON.stringify({ fake: "reply", step: 3 }),
		result({ response: "ignored" }),
	]);
	const streamFn = createAgyStreamFunction(runAgy);

	const first = doneMessage(await turn(streamFn, [HI]));
	assert.equal(first.stopReason, "toolUse");
	assert.equal(text(first), "Let me look.");
	const toolCall = first.content.find((block) => block.type === "toolCall");
	assert.deepEqual(toolCall && { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }, { id: "run:2", name: "read", arguments: { path: "a.txt" } });

	const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: "run:2", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 0 };
	const second = doneMessage(await turn(streamFn, [HI, first, toolResult]));
	assert.equal(second.stopReason, "stop");
	assert.equal(text(second), "file body");
	assert.equal(spawns.length, 1, "the answer must continue the waiting process, not replay");
	await waitForExit(spawns[0]!.child);
	await waitForRemoval(spawns[0]!.cwd);
});

test("the closing line of the step that issued a call may trail its MCP request without failing the turn", async (t) => {
	const { runAgy } = createFakeRun(t, [
		agentStep(1, "ACTIVE", { text_delta: "Checking" }),
		JSON.stringify({ fake: "start-call", step: 2, name: "read", arguments: {} }),
		agentStep(1, "DONE", { usage: { input_tokens: 7, output_tokens: 1 } }),
		HOLD,
	]);
	const message = doneMessage(await turn(createAgyStreamFunction(runAgy), [HI]));
	assert.equal(message.stopReason, "toolUse");
	assert.equal(text(message), "Checking");
	assert.equal(message.usage.input, 7, "the trailing step usage must be counted");
});

test("a failed result surfaces the CLI's error", async (t) => {
	const { runAgy } = createFakeRun(t, [result({ status: "ERROR", error: "model api cannot be reached" })]);
	const events = await turn(createAgyStreamFunction(runAgy), [HI]);
	const event = last(events);
	assert.equal(event.type, "error");
	assert.equal(event.type === "error" ? event.error.errorMessage : undefined, "model api cannot be reached");
});

test("a nonzero exit before a result is an error", async (t) => {
	const { runAgy } = createFakeRun(t, [JSON.stringify({ fake: "exit", code: 3, stderr: "boom" })]);
	const event = last(await turn(createAgyStreamFunction(runAgy), [HI]));
	assert.equal(event.type, "error");
	assert.equal(event.type === "error" ? event.error.errorMessage : undefined, "agy CLI exited with code 3");
});

test("a missing binary reports agy not found", async () => {
	const event = last(await turn(createAgyStreamFunction(() => null), [HI]));
	assert.equal(event.type, "error");
	assert.equal(event.type === "error" ? event.error.errorMessage : undefined, AgyError.CliNotFound);
});

test("aborting kills the process and removes its resources", async (t) => {
	const { runAgy, spawns } = createFakeRun(t, [HOLD]);
	const controller = new AbortController();
	const pending = turn(createAgyStreamFunction(runAgy), [HI], { signal: controller.signal });
	while (spawns.length === 0) await sleep(10);
	controller.abort();
	const event = last(await pending);
	assert.equal(event.type, "error");
	assert.equal(event.type === "error" ? event.error.stopReason : undefined, "aborted");
	await waitForExit(spawns[0]!.child);
	await waitForRemoval(spawns[0]!.cwd);
});

test("the bridge refuses a call without a progressToken and reports it", async () => {
	const errors: string[] = [];
	const bridge = await createToolBridge([READ_TOOL], { onCall: () => {}, onError: (error) => errors.push(error.message) }, AGY_BRIDGE_PROFILE);
	const { url, headers } = (JSON.parse(bridge.mcpConfig) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }).mcpServers.learnharness!;
	const client = new Client({ name: "test", version: "1.0.0" });
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
		await assert.rejects(client.callTool({ name: "read", arguments: {} }), /unique progressToken/);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /agy CLI compatibility error: MCP calls must include a unique progressToken$/);
		assert.deepEqual(bridge.getPendingToolCalls(), []);
	} finally {
		await client.close();
		await bridge.close();
	}
});

test("effort follows the model's own levels and clamps the rest", () => {
	assert.equal(toAgyEffort(model("claude-opus-5-5"), "low"), "low");
	assert.equal(toAgyEffort(model("claude-opus-5-5"), "minimal"), "low");
	assert.equal(toAgyEffort(model("claude-opus-5-5"), undefined), "medium");
	assert.equal(toAgyEffort(model("gemini-4-argon"), "xhigh"), "high");
	assert.equal(toAgyEffort(model("gemini-4-argon"), "max"), "high");
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) assert.equal(toAgyEffort(model("gpt-oss-120b"), level), "medium");
	assert.deepEqual(toAgyArgs({ model: "x", effort: "low" }).slice(4), ["--model", "x", "--effort", "low", "--agent", "learnharness"]);
});

test("the catalog lists five text-only, unpriced model families", () => {
	assert.deepEqual(AGY_MODELS.map((m) => m.id), ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]);
	for (const m of AGY_MODELS) {
		assert.deepEqual(m.input, ["text"]);
		assert.deepEqual(Object.values(m.cost), [0, 0, 0, 0]);
		assert.equal(m.provider, "agy");
	}
});

test("parseAgyLine maps deltas, step ends and results; tool steps are not events", () => {
	assert.deepEqual(parseAgyLine(agentStep(1, "DONE", { text_delta: "x", thinking_delta: "t", usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3 } })), [
		{ type: "thinkingDelta", step: 1, thinking: "t" },
		{ type: "textDelta", step: 1, text: "x" },
		{ type: "stepEnd", step: 1, stepType: "agent_response", usage: { input: 1, output: 2, cacheRead: 3 } },
	]);
	assert.deepEqual(parseAgyLine(agentStep(1, "ACTIVE", { text_delta: "x" })), [{ type: "textDelta", step: 1, text: "x" }]);
	assert.deepEqual(parseAgyLine(step(2, "ACTIVE", { step_type: "tool", tool_name: "mcp_learnharness_read" })), []);
	assert.deepEqual(parseAgyLine(result({ response: "ok" })), [{ type: "result", ok: true, text: "ok" }]);
	assert.deepEqual(parseAgyLine(result({ status: "ERROR", error: "bad" })), [{ type: "result", ok: false, text: "bad" }]);
	assert.deepEqual(parseAgyLine(result({ status: "ERROR", finished_reason: "interrupted" })), [{ type: "result", ok: false, text: "agy CLI failed: interrupted" }]);
	assert.deepEqual(parseAgyLine("not json"), []);
	assert.deepEqual(parseAgyLine(JSON.stringify({ event: "init" })), []);
});

test("stdin carries a text-only user event", () => {
	assert.deepEqual(JSON.parse(toStreamJsonLine("hi")), { event: "user", message: { role: "user", content: "hi" } });
});

test("binary lookup honors PATH before known directories and requires an executable", () => {
	const executables = new Set(["/opt/homebrew/bin/agy", "/custom/agy"]);
	const lookup = { env: { PATH: "/custom:/usr/bin" }, platform: "darwin" as const, homeDir: "/home/u", isExecutable: (p: string) => executables.has(p) };
	assert.equal(resolveAgyBinary(lookup), "/custom/agy");
	assert.equal(resolveAgyBinary({ ...lookup, env: {} }), "/opt/homebrew/bin/agy");
	assert.equal(resolveAgyBinary({ ...lookup, isExecutable: () => false }), null);
	assert.equal(resolveAgyBinary({ ...lookup, platform: "win32", homeDir: "C:\\Users\\u", env: { PATH: "" }, isExecutable: (p) => p.endsWith("agy.exe") }), "C:\\Users\\u\\.local\\bin\\agy.exe");
});

test("installation reports version states without exposing CLI output", async () => {
	const inspect = (output: string | Error, binary: string | null = "/bin/agy") =>
		inspectAgyInstallation(() => binary, async () => { if (output instanceof Error) throw output; return output; });
	const base = { minimumVersion: AGY_MINIMUM_VERSION };
	assert.deepEqual(await inspect("1.5.6\n"), { ...base, version: "1.5.6", state: "meets-minimum" });
	assert.deepEqual(await inspect("1.5.0"), { ...base, version: "1.5.0", state: "meets-minimum" });
	assert.deepEqual(await inspect("1.4.9"), { ...base, version: "1.4.9", state: "update-required" });
	assert.deepEqual(await inspect("2.0.0"), { ...base, version: "2.0.0", state: "meets-minimum" });
	assert.deepEqual(await inspect("agy dev /secret/path"), { ...base, version: null, state: "version-unchecked" });
	assert.deepEqual(await inspect(new Error("timeout")), { ...base, version: null, state: "version-unchecked" });
	assert.deepEqual(await inspect("1.5.6", null), { ...base, version: null, state: "not-found" });
});
