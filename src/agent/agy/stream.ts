import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { externalCliEnv } from "../../core/auth-env.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { createToolBridge, type PendingToolCall, type ToolBridge } from "../claude-code/tool-bridge.ts";
import { AGY_BRIDGE_PROFILE } from "./bridge.ts";
import { parseAgyLine, type AgyEvent, type AgyUsage } from "./cli-events.ts";
import { AGY_AGENT_NAME, AgyError } from "./constants.ts";
import { AgyLaunchError, createAgyLauncher } from "./launch.ts";
import { toAgentFile, toAgyInput, toStreamJsonLine } from "./transcript.ts";

type RunAgyOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type AgyChild = ChildProcessWithoutNullStreams | null;
export type RunAgy = (args: string[], options: RunAgyOptions) => AgyChild | Promise<AgyChild>;

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";

// agy can write the closing line of the step that issued a call just after the call's MCP request
// (observed: 1 ms). Admission waits this long so that line still lands in the call's own message.
const ADMISSION_SETTLE_MS = 25;

/** agy accepts only the levels its model lists (see provider.ts); everything else is clamped into the
 * model's own map: minimal -> low, xhigh/max -> high, then the model's medium. */
export function toAgyEffort(model: Model<Api>, level: ThinkingLevel | undefined): string {
	const wanted = level === "minimal" ? "low" : level === "xhigh" || level === "max" ? "high" : level ?? "medium";
	const map = model.thinkingLevelMap ?? {};
	return map[wanted] ?? map.medium ?? "medium";
}

export function toAgyArgs(input: { model: string; effort: string }): string[] {
	return [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--model",
		input.model,
		"--effort",
		input.effort,
		"--agent",
		AGY_AGENT_NAME,
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** One pi assistant message. agy runs harness tools strictly one at a time, so a turn ends at its
 * first admitted call (stopReason toolUse) or at agy's `result` event. */
class AgyTurn {
	private readonly output: AssistantMessage;
	/** The text/thinking block currently receiving deltas, keyed by agy step. */
	private open: { step: number; type: "text" | "thinking"; contentIndex: number } | null = null;
	started = false;
	finished = false;

	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) {
		this.output = createOutput(model);
	}

	handle(event: AgyEvent): void {
		if (this.finished) return;

		switch (event.type) {
			case "textDelta":
				this.delta(event.step, "text", event.text);
				return;

			case "thinkingDelta":
				this.delta(event.step, "thinking", event.thinking);
				return;

			case "stepEnd":
				this.closeBlock();
				this.addUsage(event.usage);
				return;

			case "result":
				if (event.ok) this.finish();
				else this.fail(event.text, "error");
				return;
		}
	}

	getMessage(): AssistantMessage { return this.output; }

	admit(calls: ToolCall[]): void {
		this.start();
		this.closeBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finish();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;

		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;

		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private delta(step: number, type: "text" | "thinking", text: string): void {
		this.start();
		if (this.open && (this.open.step !== step || this.open.type !== type)) this.closeBlock();
		if (!this.open) {
			const contentIndex = this.output.content.length;
			this.open = { step, type, contentIndex };
			if (type === "text") {
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
			} else {
				this.output.content.push({ type: "thinking", thinking: "" });
				this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
			}
		}
		const { contentIndex } = this.open;
		const block = this.output.content[contentIndex]!;
		if (block.type === "text") {
			block.text += text;
			this.stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.output });
		} else if (block.type === "thinking") {
			block.thinking += text;
			this.stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: this.output });
		}
	}

	private closeBlock(): void {
		if (!this.open) return;

		const { contentIndex } = this.open;
		const block = this.output.content[contentIndex]!;
		this.open = null;
		if (block.type === "text") this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		else if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
	}

	/** Each agent step is one model call; the message's usage is their sum. */
	private addUsage(usage: AgyUsage): void {
		const total = this.output.usage;
		total.input += usage.input ?? 0;
		total.output += usage.output ?? 0;
		total.cacheRead += usage.cacheRead ?? 0;
		total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
	}

	private finish(): void {
		this.start();
		this.closeBlock();
		this.finished = true;
		if (this.output.stopReason === "pending") this.output.stopReason = "stop";
		this.stream.push({ type: "done", reason: this.output.stopReason as "stop" | "toolUse", message: this.output });
		this.stream.end();
	}
}

type TurnFiles = { cwd: string };

/** The launch cwd carries everything agy reads: the agent file (system prompt) and the MCP config
 * with the bridge's bearer token. mkdtemp creates it 0700; both files are 0600. */
async function createTurnFiles(systemPrompt: string, mcpConfig: string): Promise<TurnFiles> {
	const cwd = await mkdtemp(join(tmpdir(), "agy-cwd-"));
	try {
		await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
		await writeFile(join(cwd, ".agents", "agents", `${AGY_AGENT_NAME}.md`), toAgentFile(AGY_AGENT_NAME, systemPrompt), { mode: 0o600 });
		await writeFile(join(cwd, ".agents", "mcp_config.json"), mcpConfig, { mode: 0o600 });
		return { cwd };
	} catch (error) {
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

async function removeTurnResources(bridge: ToolBridge, files: TurnFiles): Promise<void> {
	await Promise.all([bridge.close(), rm(files.cwd, { recursive: true, force: true })]);
}

class AgyProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	/** Calls handed to pi and still held open in the CLI, awaiting their results. */
	private admitted: PendingToolCall[] = [];
	/** The newest step index among admitted calls (a call id ends in `:<step>`); earlier steps may still close. */
	private admittedStep = 0;
	private admissionTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private turn: AgyTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {}

	start(stdinLine: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("agy CLI stdin closed early:", error));
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try { this.handleLine(line); }
			catch { this.fail("agy CLI emitted malformed stream output"); }
		});
		this.setSignal(signal);
		if (!this.stopping) this.child.stdin.write(`${stdinLine}\n`);
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: AgyTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.admittedStep = 0;
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.flushAdmissions();
	}

	kill(): void {
		removeLiveProcess(this);
		clearTimeout(this.admissionTimer);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		this.turn.fail(message, "error");
		this.kill();
	}

	/** Only authenticated MCP requests admit side effects; the stream's tool steps carry no arguments. */
	flushAdmissions(): void {
		if (this.stopping || this.turn.finished || this.admissionTimer) return;
		this.admissionTimer = setTimeout(() => { this.admissionTimer = undefined; this.admitPending(); }, ADMISSION_SETTLE_MS);
	}

	private admitPending(): void {
		if (this.stopping || this.turn.finished) return;
		const calls = this.bridge.getPendingToolCalls().filter((call) => !this.admitted.includes(call));
		if (calls.length === 0) return;
		const steps = calls.map((call) => Number(call.id.split(":").at(-1)));
		this.admittedStep = steps.every(Number.isFinite) ? Math.max(...steps) : Infinity;
		this.admitted = calls;
		this.toolCallIds = calls.map((call) => call.id);
		this.turn.admit(calls.map((call): ToolCall => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })));
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) addLiveProcess(this);
		else this.kill(); // No trusted scope: return the call, then use fresh replay.
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		for (const event of parseAgyLine(line)) {
			if (this.turn.finished) {
				// The closing line of an earlier step may trail its successor's call; its usage is already past.
				if (event.type !== "result" && event.step < this.admittedStep) continue;
				// Anything newer while a call is held means agy did not wait for the result.
				this.fail("agy CLI moved on while harness tool calls were waiting for results");
				return;
			}
			this.turn.handle(event);
			if (this.turn.finished) { this.kill(); return; }
		}
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		clearTimeout(this.admissionTimer);
		removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (this.stderr.trim()) console.error("agy CLI stderr:", this.stderr.trim());
		this.turn.fail(message, "error");
		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("agy CLI cleanup failed:", error);
		});
	}
}

function continueLiveProcess(turn: AgyTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AgyProcess)) return false;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(
	runAgy: RunAgy,
	turn: AgyTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toAgyInput(context.messages);
	let cliProcess: AgyProcess | undefined;
	const bridge = await createToolBridge(input.tools, {
		onCall: () => cliProcess?.flushAdmissions(),
		onError: (error) => cliProcess?.fail(error.message),
	}, AGY_BRIDGE_PROFILE);
	let files: TurnFiles;
	try {
		files = await createTurnFiles(input.systemPrompt, bridge.mcpConfig);
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await removeTurnResources(bridge, files);
		return;
	}

	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = await runAgy(toAgyArgs({ model: model.id, effort: toAgyEffort(model, options?.reasoning) }), { cwd: files.cwd, env, signal: options?.signal });
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(AgyError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	cliProcess = new AgyProcess(child, bridge, files, turn, owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	cliProcess.start(toStreamJsonLine(input.userText), options?.signal);
}

export function createAgyStreamFunction(runAgy: RunAgy): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("agy stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AgyTurn(stream, model);

		// Preserve native CLI auth/routing: agy chooses the account and billing method, not LearnHarness.
		const env = externalCliEnv();
		// An existing child must not retain stale authentication/routing after env changes.
		const configuration = { request: configurationForReuse(model, context, toAgyEffort(model, options?.reasoning)), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runAgy, turn, model, context, options, owner, configuration, env).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			turn.fail(options?.signal?.aborted ? ABORT_MESSAGE : error instanceof AgyLaunchError ? error.message : START_FAILED_MESSAGE, options?.signal?.aborted ? "aborted" : "error");
		});

		return stream;
	};
}

export const streamAgy = createAgyStreamFunction(createAgyLauncher());
