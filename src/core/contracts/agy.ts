export const AGY_PROVIDER = "agy";

/** Installation/version only. Never an authentication, quota, or billing verdict. */
export interface AgyStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
}

// Print-mode stream-json, `--effort` and `.agents/mcp_config.json` with `url` were
// verified on 1.5.6. 1.5.0 is the minimum the MCP `alwaysLoad` changelog entry implies.
export const AGY_MINIMUM_VERSION = "1.5.0";
