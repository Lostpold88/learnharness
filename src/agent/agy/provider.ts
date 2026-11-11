import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";

import { AGY_API, AGY_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: AGY_API,
	provider: AGY_PROVIDER,
	baseUrl: "",
	// agy's stream-json input accepts text blocks only.
	input: ["text"],
	// Pi-required placeholders, not prices: the CLI's own auth/routing
	// determines charges. Server pricing and the client catalog report unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name" | "thinkingLevelMap">;

// `agy --effort` accepts exactly these per model (verified on 1.5.6); there is no off switch.
const LOW_TO_HIGH = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as const;
const MEDIUM_ONLY = { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null } as const;

export const AGY_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "gemini-4-argon", name: "Gemini 4 Argon", thinkingLevelMap: LOW_TO_HIGH },
	{ ...SHARED_MODEL_FIELDS, id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevelMap: LOW_TO_HIGH },
	{ ...SHARED_MODEL_FIELDS, id: "claude-opus-5-5", name: "Claude Opus 5.5", thinkingLevelMap: LOW_TO_HIGH },
	{ ...SHARED_MODEL_FIELDS, id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", thinkingLevelMap: LOW_TO_HIGH },
	{ ...SHARED_MODEL_FIELDS, id: "gpt-oss-120b", name: "GPT-OSS 120B", thinkingLevelMap: MEDIUM_ONLY },
];

export function createAgyProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: AGY_PROVIDER,
		name: "Antigravity",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: AGY_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
