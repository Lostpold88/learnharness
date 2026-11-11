# Antigravity: gaps to Claude Code parity

[Antigravity](agy.md) is integrated like [Claude Code](claude-code.md), but it is **not yet equivalent**. This page lists what is missing, why, and what closing each gap needs. It reflects `agy` 1.5.6. Nothing here is a promise; items marked **design** need an owner decision before work starts.

Legend: **Confirmed** = observed against the real CLI. **Unverified** = built by analogy to Claude Code, never exercised end to end.

## Confirmed limitations of the CLI

| # | Gap | Why | To close | |
| --- | --- | --- | --- | --- |
| 1 | **No images.** Antigravity models cannot be picked for the Vision slot (Visual maker, PDF reader); replayed images become a text placeholder. | `agy` stream-json input rejects every non-`text` block: `stream input content block type "image" is not supported (only "text")`. | Check whether `agy` can read an image from a file path while its built-in file tools are excluded; otherwise wait for CLI support. A scoped read tool would widen the isolation boundary. | design |
| 2 | **Tool calls are sequential.** A message holds at most one call; a model asked for parallel calls gets them one after another. | `agy` runs MCP calls one step at a time. | Nothing to fix in LearnHarness; look for a CLI setting. | |
| 3 | **No thinking text.** The UI shows no reasoning blocks. | `agy` streams only `thinking_tokens` in usage, never the text. | CLI change. `usage.reasoning` is not set because thinking tokens are already part of `output_tokens`. | |
| 4 | **Fewer effort levels.** Gemini/Claude families: low, medium, high; GPT-OSS 120B: medium only. Claude Code offers up to max. | `agy --effort` rejects other levels per model. | None; the catalog already reflects it. Re-probe when the CLI adds models. | |
| 5 | **Built-in helper tools stay reachable.** `list_resources`, `manage_task` and `call_mcp_tool` remain callable; file and shell tools are gone. | `excludeDefaultComponents` removes the coding tools, not the MCP helpers. A frontmatter `tools:` list fails with `tool ... not found in registry`. | Test whether `--settings` or the agent file can deny them. Today a call only errors harmlessly. | |
| 6 | **CLI-side state.** Each conversation leaves artifacts under the user's `~/.gemini/antigravity-cli/brain/`. | No verified flag disables persistence (Claude Code is started with `--no-session-persistence`). | Look for a flag or setting; otherwise document or clean up. | design |

## Product gaps

| # | Gap | Detail | To close | |
| --- | --- | --- | --- | --- |
| 7 | **No context window.** The meter shows usage without a limit and the side-chat budget check has nothing to compare against. | Claude Code reports a window through a control request; `agy` has no equivalent. | Find a reported value, or pin a verified window per model. Also check what compaction's threshold does when the window is unknown. | design |
| 8 | **Settings do not check sign-in.** Status is version only; a signed-out CLI fails at the first request. | The result error for "not signed in" has not been observed, so it is not mapped to a friendly message. | Sign out, capture the error, map it. Optionally use `agy --output-format json status` (`authenticated`) for the Settings row. | design |
| 9 | **Fixed model list.** Five families are hardcoded in `src/agent/agy/provider.ts`. | `agy --output-format json models` lists 13 ids and can change. | Discover families at runtime, keep the verified effort map as the fallback. | design |
| 10 | **Minimum version is a floor from the changelog, not a tested one.** | Only 1.5.6 was run. `alwaysLoad` is documented from 1.3.5; the versions for `--effort`, `url` in `mcp_config.json` and print-mode stream-json were not checked. | Run the live smoke test on the oldest installable version and raise the floor if it fails. | |

## Not yet exercised in the real app

Built by analogy to Claude Code and covered by a fake-CLI test; **Unverified** against real `agy` inside the app:

- The learner-question loop (a call held until the learner answers), including answers after minutes.
- Canvas, Flashcards, Notes, PDF and Delegate/subagents; side chat; background jobs and compaction; retry after an error.
- Holds longer than the 94 s tried live, the 10-minute idle expiry and abort in the middle of a call.
- The `send_to_user` output tool: it is offered only to models whose id contains `claude` (and to the Claude Code provider), so Gemini and GPT-OSS through `agy` do not get it. Whether they need it is unknown.
- Windows and Linux: binary lookup is unit-tested, spawning is not.
- A packaged macOS app launched from Finder, whose `PATH` differs from a terminal; discovery relies on the `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` fallbacks.

## Test gaps

Claude Code has these; Antigravity does not yet:

- A harness test through the real chat handler (question ends the turn, answer continues the process, spawn count proves reuse).
- Negative reuse cases (changed model, effort, tools, history, environment must start fresh), idle-timeout expiry, and cancel of queued calls.
- Launcher version gating (`update-required` / unchecked refuse to spawn) and the env filter that strips LearnHarness-only credentials.
- Usage and context UI tests.

## Suggested order

1. Run the real-app checks above and fix what breaks (cheapest, highest value).
2. Capture the signed-out error (#8) and settle the context-window question (#7).
3. Add the missing tests.
4. Decide on image support (#1) and model discovery (#9).
