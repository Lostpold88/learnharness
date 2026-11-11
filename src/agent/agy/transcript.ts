import type { Message, Tool } from "@earendil-works/pi-ai";
import { toClaudeInput } from "../claude-code/transcript.ts";

export type AgyInput = { systemPrompt: string; tools: Tool[]; userText: string };

const IMAGE_OMITTED = "[image omitted: Antigravity accepts text only]";

/** The replay format is the claude-code one (labelled turns, one user message); agy's stdin takes no image blocks. */
export function toAgyInput(messages: Message[]): AgyInput {
	const { systemPrompt, tools, userContent } = toClaudeInput(messages);
	return { systemPrompt, tools, userText: userContent.map((block) => block.type === "text" ? block.text : IMAGE_OMITTED).join("\n\n") };
}

export function toStreamJsonLine(text: string): string {
	return JSON.stringify({ event: "user", message: { role: "user", content: text } });
}

/** The agent file `--agent` loads from the launch cwd. `excludeDefaultComponents` removes agy's own
 * coding prompt and its file/shell tools; `inheritCustomizations` keeps user rules and skills out. */
export function toAgentFile(name: string, systemPrompt: string): string {
	return `---\nname: ${name}\ndescription: LearnHarness agent\nexcludeDefaultComponents: true\ninheritCustomizations: false\n---\n${systemPrompt}\n`;
}
