import { BRIDGE_SERVER_NAME, type BridgeProfile } from "../claude-code/tool-bridge.ts";

// A held call (a question tool waits for the learner) sends no progress; the CLI's own
// per-call timeout must outlast the live-process idle timeout, which kills first.
export const AGY_MCP_TIMEOUT_SECONDS = 30 * 60;

/** agy sends no tool-use id; `progressToken` is `<run uuid>:<step index>`, unique per call. */
export const AGY_BRIDGE_PROFILE: BridgeProfile = {
	callId: (meta) => meta?.progressToken,
	identityError: "agy CLI compatibility error: MCP calls must include a unique progressToken",
	undeclaredToolError: "agy CLI requested an undeclared harness tool",
	// Eager loading hands the tool to the model directly instead of behind call_mcp_tool.
	toolMeta: { "antigravity/alwaysLoad": true },
	config(url, authorization) {
		return JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: { url, headers: { Authorization: authorization }, timeoutSeconds: AGY_MCP_TIMEOUT_SECONDS } } });
	},
};
