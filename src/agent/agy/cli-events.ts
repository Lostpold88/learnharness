import type { Usage } from "@earendil-works/pi-ai";

export type AgyUsage = Partial<Pick<Usage, "input" | "output" | "cacheRead">>;

export type AgyEvent =
	| { type: "textDelta"; step: number; text: string }
	| { type: "thinkingDelta"; step: number; thinking: string }
	| { type: "stepEnd"; step: number; stepType: string; usage: AgyUsage }
	| { type: "result"; ok: boolean; text: string };

type RawUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_tokens?: number | null };

type RawStep = {
	step_index?: number;
	state?: string;
	step_type?: string;
	text_delta?: string;
	thinking_delta?: string;
	usage?: RawUsage;
};

type RawLine = {
	event?: string;
	step_update?: RawStep;
	result?: { status?: string; response?: string; error?: string; finished_reason?: string };
};

function toUsage(raw: RawUsage | undefined): AgyUsage {
	const usage: AgyUsage = {};
	if (typeof raw?.input_tokens === "number") usage.input = raw.input_tokens;
	if (typeof raw?.output_tokens === "number") usage.output = raw.output_tokens;
	if (typeof raw?.cache_read_tokens === "number") usage.cacheRead = raw.cache_read_tokens;
	return usage;
}

/** One stdout line becomes events in order: a delta, then the step end when the step is DONE
 * (the last delta rides on the DONE line). Tool steps are not events: only the MCP request
 * carries a tool call's name, arguments and identity. */
export function parseAgyLine(text: string): AgyEvent[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const line = parsed as RawLine;

	if (line.event === "result" && line.result) {
		const { status, response, error, finished_reason: reason } = line.result;
		const ok = status === "SUCCESS";
		return [{ type: "result", ok, text: ok ? response ?? "" : error || `agy CLI failed: ${reason ?? status ?? "unknown error"}` }];
	}

	const step = line.step_update;
	if (line.event !== "step_update" || !step || typeof step.step_index !== "number") return [];
	const events: AgyEvent[] = [];
	if (step.step_type === "agent_response") {
		if (typeof step.thinking_delta === "string" && step.thinking_delta) events.push({ type: "thinkingDelta", step: step.step_index, thinking: step.thinking_delta });
		if (typeof step.text_delta === "string" && step.text_delta) events.push({ type: "textDelta", step: step.step_index, text: step.text_delta });
		if (step.state === "DONE" || step.state === "ERROR") {
			events.push({ type: "stepEnd", step: step.step_index, stepType: step.step_type, usage: toUsage(step.usage) });
		}
	}
	return events;
}
