# Antigravity

> Not yet equivalent to Claude Code: see [parity gaps](agy-parity.md) for known limits and unverified areas.

LearnHarness can use an externally installed **Antigravity CLI (`agy`)** as a model provider. The CLI owns authentication, routing, model access, and billing; LearnHarness does **not** guarantee subscription-only use.

## Set up

1. Install `agy` and sign in outside LearnHarness, on **the machine running the LearnHarness server**, under its OS user. No always-running process is needed.
2. Make the executable discoverable in that server's `PATH`, `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`. On Windows a directly runnable `agy.exe` is required.
3. Enable **Settings → Providers → External CLI → Antigravity**. This app-wide opt-in is **off by default**. Use **Check again** to refresh installation status.
4. Select an Antigravity model: Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5 or GPT-OSS 120B.

The minimum version is **1.5.0** ([contract](../src/core/contracts/agy.ts)); the integration was verified on 1.5.6. The check runs only `--version`, not `status` or inference. Passing proves neither sign-in, account access, quota, nor billing method. A signed-out CLI fails at the first request.

## Models and thinking level

The thinking selector maps to `agy --effort` with the base model id. Each model accepts only its own levels: the four Gemini/Claude families take `low`, `medium` and `high`; GPT-OSS 120B takes `medium` only. Higher requested levels are clamped, never sent. There is no off switch.

Models are **text only**. `agy`'s stream-json input rejects image blocks, so replayed images become a text placeholder. The CLI reports no context window, so the context meter shows usage without a limit, as for Claude Code. The CLI streams no thinking text; its thinking tokens are part of the reported output tokens.

## What goes through the CLI

LearnHarness keeps control of its agent loop, tools, questions, saved history, and jobs, and supplies prompts, relevant history, and tool results to the CLI's configured service.

Each child runs without a shell in an empty temporary working directory containing two private files (mode 0600), removed when the child ends:

- `.agents/agents/learnharness.md`, selected with `--agent`. Its body is the LearnHarness system prompt; `excludeDefaultComponents: true` drops `agy`'s coding prompt and its file and shell tools, and `inheritCustomizations: false` keeps user rules and skills out.
- `.agents/mcp_config.json`, pointing at a token-protected loopback MCP bridge that exposes LearnHarness's own tools. Tools are marked `antigravity/alwaysLoad` so the model gets them directly, and the per-call timeout is 30 minutes.

`agy` sends no tool-use id. A call's identity is its MCP `progressToken` (`<run>:<step>`), and execution requires an authenticated MCP request: the stream's tool steps carry no arguments and never execute anything. The CLI runs tool calls **strictly one at a time**, so a message holds at most one call and parallel requests become sequential.

These are integration boundaries, **not an OS sandbox**. `agy` keeps its own conversation record under its home directory, and `agy`'s MCP helper tools (`list_resources`, `manage_task`, `call_mcp_tool`) remain available to the model. Bounded stderr is logged when the process closes.

## Questions, reuse, and cancellation

The persisted LearnHarness transcript is authoritative. A child exits after its final response; it stays alive while a tool call is held (including a learner question) and resumes only for the same owner/session and compatible history, tools, model, prompt, effort, and environment. Held children expire after **10 minutes** idle, after which the next call starts fresh and replays history as labelled text, as for [Claude Code](claude-code.md#questions-reuse-and-cancellation). Abort terminates the child and removes the temporary directory.
