export { AGY_PROVIDER } from "../../core/contracts/agy.ts";

export const AGY_API = "agy-cli";

/** The custom-agent file name: `--agent` selects `.agents/agents/<name>.md` in the launch cwd. */
export const AGY_AGENT_NAME = "learnharness";

export enum AgyError {
	CliNotFound = "agy CLI not found",
}
