# Changelog

## 0.4.0

The roster now matches OpenCode's own model picker instead of the bundled
catalogue, and retired models no longer reach it:

- Free is `cost.input === 0` on the `opencode` provider with
  `status !== "deprecated"` — the picker's exact test
  (`cli/cmd/tui/component/dialog-model.tsx`). The earlier "all four prices are
  zero" rule was ours, not OpenCode's.
- `fetchDynamicModels` reads `https://models.dev/api.json` — the price list
  OpenCode itself reads (`provider/models.ts`) — instead of
  `GET /zen/v1/models`. That drops the retired ids (Zen now answers them with
  `410 ModelDeprecated`) and replaces them with the live zero-price set: 10
  models on 2026-10-18, each with its upstream display name and limits.
- Id heuristics are gone: no `-free` suffix matching, no `jev-*` denylist, no
  invented "Free" names. An id omp's catalogue has not seen is registered only
  because models.dev prices its input at zero, using models.dev's own metadata.
- The refresh no longer sends the Zen credential to models.dev; it was only
  ever a public read.
- Registration now fetches the live roster itself (4 s budget) instead of
  registering the bundled catalogue. omp merges the registered list with the
  dynamic one, so the bundle's retired ids survived every refresh: on omp
  18.12.1 the picker exposed 36 ids (bundle 32 ∪ live 10) until registration
  moved to the live fetch, and then exactly the 10. The extension factory is
  async, which the host supports.
- Documented invocation fixed: `--provider opencode-zen-free` is rejected
  (`Unknown provider`) on omp 18.12.1 for extension providers, built-ins
  resolve fine, and `--model opencode-zen-free/<id>` is the form that works.
- `test/live.ts` probes models taken from the live roster (image-capable for the
  vision check, all four checks passed 2026-10-18) and skips the Responses lane
  while no free model uses it.
- Deleted an untracked scratch copy of the old provider (`src/provider.static.ts`)
  that `tsconfig` and `files` would have type-checked and published.

## 0.3.0

Standalone OpenCode client (`src/opencode-client.ts`) that recreates
opencode 1.19.0 inference requests byte-for-byte, recovered from an HTTP
capture (`opencode.xml`, Http 312/323) and cross-checked against the request
builder in the installed 1.19.0 binary:

- Headers reach the wire sorted by code unit, matching the capture:
  `Authorization`, `Content-Type`, `User-Agent` (base + `ai-sdk/provider-utils/<lane>`
  + `runtime/bun/1.3.14`), then `x-opencode-{client,project,request,session,session-id}`.
  `rawRequestBlock` also emits the Bun-appended `Connection`/`Accept`/`Host`/
  `Accept-Encoding`/`Content-Length` lines.
- Bodies use exact per-lane key order (responses: `model, input,
  max_output_tokens, store, include, reasoning, stream`; chat: `model,
  max_tokens, messages, tools, tool_choice, stream`), compact JSON, tools
  sorted by function name.
- Byte-level fixture tests prove the responses body equals the captured
  3895-byte payload and the header block matches line for line.
- Unit tests for the extension entry (`test/plugin.test.ts`): registration
  contract, free-tier config identity, roster filtering, and the `/login`
  flow.

## 0.2.0

Port to omp (oh-my-pi) 18.11.1. Verified end to end in omp: provider
registration, `omp models opencode-zen-free`, and a turn whose tool call ran
through omp's own `read` tool.

- Registration uses omp's extension API (`pi.registerProvider(id, config)` with
  an extension-owned api id and `streamSimple`), replacing the Pi
  `createProvider` / `registerApiProvider` / `api` map surface, which omp does
  not provide.
- Transport delegates to omp's own `streamSimple`, so streaming, tool calls,
  reasoning, usage, and aborts behave exactly as they do for a built-in
  provider.
- Free roster comes from omp's bundled `opencode-zen` catalogue
  (`@oh-my-pi/pi-catalog/models`); `fetchDynamicModels` refreshes it from
  `GET /zen/v1/models` and the host caches discovery with the static list as
  fallback.
- Credential precedence: `/login opencode-zen-free` → `OPENCODE_API_KEY` →
  anonymous `public`.
- Request identity: base URL `https://opencode.ai/zen/v1`, a `ses_` id minted
  per omp session in `x-opencode-session`, `x-opencode-client: cli`, UA
  `opencode/latest/2.0.26/cli`, and `Authorization`. Auxiliary calls without
  tools get one inert `read` placeholder plus a note; caller tools, history,
  and system prompts are never rewritten.
- Responses-lane models carry the catalogue `compat` object into the delegated
  call. omp's OpenCode Responses handler dereferences `model.compat` at session
  start and the registry leaves the field undefined for extension-registered
  models, so a Responses turn used to crash with `undefined is not an object
  (evaluating 'e.compat.connectionBoundNativeHistory')` before any request went
  out. Chat Completions models stay exactly as omp resolved them.
- Responses-lane rotation is retried once with stale `reasoning` items
  stripped (unchanged behaviour, same helper).
- Removed as unnecessary, each verified by live probe: the `read` →
  `read_client` alias (the gate checks tool names, not definitions; aliasing is
  what makes a model call the wrong tool), the OpenCode compaction-prompt swap
  (system-prompt content is not gated), the pi-ai compat-registry patch, the
  global fetch guard, and the `node:http` guard (all Pi side-channel plumbing).
- Debug switch renamed to `OMP_OPENCODE_FREE_DEBUG`.
- Tests run under Bun. The fixture suite covers session minting and decoding,
  credential precedence, tool passthrough and placeholder injection, request
  identity, catalogue filtering, rotation retry, and a stubbed SSE stream with
  a tool call. `bun run test/live` exercises both wire lanes against the real
  anonymous free tier, including a tool-less compaction-style request.

## 0.1.9

- Auto-register unknown free Zen models (e.g. `step-5-preview-free`):
  `refreshModels()` synthesizes conservative entries for free-looking IDs
  served by Zen but missing from the bundled `pi-ai` catalogue (Chat
  Completions transport, Responses variant for future `muse-spark-*` IDs),
  and the stored-model restore path reattaches them instead of dropping
  them. Paid IDs and non-chat `jev-*` classifiers stay excluded. Official
  metadata from `pi update --models` replaces synthetics automatically;
  fine-tuning stays possible via `modelOverrides` in `models.json`.
- Note: models Zen's live catalogue is not currently serving (rotation gaps
  such as `step-5-preview-free` or `nemotron-3-ultra-free`) cannot be
  auto-registered — force-show them via
  `providers["opencode-zen-free"].models` in `models.json` (official
  metadata on `pi.dev/models`). Unlike `opencode models` (Models.dev
  snapshot), the picker reflects what Zen serves right now.

## 0.1.8

- Recover from the upstream free-tier gate change (OpenCode 2.x): the inference
  endpoint moved from `https://opencode.ai/zen/v1` to
  `https://opencode.ai/inference/v1`, the `User-Agent` is now
  `opencode/latest/2.0.30/cli`, and requests carry the full CLI correlation
  set (`x-opencode-session-id` / `x-session-affinity` / `X-Session-Id` alongside
  `x-opencode-session`). Session ids are now generated timestamp-based
  (`descending()` in `packages/schema/src/identifier.ts`) and cached per Pi
  session: the gate validates that the id prefix decodes to a plausible recent
  timestamp, so hash-derived ids were rejected with `FreeTierError` even with
  otherwise identical requests (found by replaying a captured CLI request).
  `x-opencode-request` and explicit `x-client-request-id` are no longer sent
  (the CLI sends neither; extra headers are ignored server-side).
  All guards re-scoped to `/inference/v1`.

## 0.1.7

- Pi 0.86.1 compatibility: adapt to the `TranscriptContext` Custom Streaming API. All `stream`/`streamSimple` paths (provider wrapper and compat side-channel patch) normalize legacy `Context` (`systemPrompt`/`tools`) to transcripts via `normalizeContext`, so direct calls keep working while Pi core sends transcripts. `swapCompactionPrompt` handles both shapes — legacy `systemPrompt` and transcript system messages read via `getCurrentSystemPrompt` (tools checked via `getCurrentTools`) — still limited to short standalone summarization prompts, user message and format untouched, keyed requests never rewritten. Debug shape summaries count transcript-declared tools.
- Pin `@earendil-works/pi-ai` to `0.86.1` in dependencies and devDependencies; tests build transcript contexts the way Pi core does.
- Ignore local Pi state (`/.pi` in `.gitignore`).

## 0.1.6

- Send OpenCode's byte-identical compaction system prompt for anonymous summarization: Zen gates anonymous free tier on the developer content, so Pi's own summarization prompt 403s while OpenCode's exact text passes with otherwise identical requests (found by diffing a working vs failing capture). `swapCompactionPrompt` replaces short standalone prompts containing the summarization marker, user message and format untouched, keyed requests never rewritten.

- Always send `x-client-request-id` (same affinity value as `x-opencode-session`): Pi core compaction forces `cacheRetention: "none"`, for which pi-ai drops its own session-affinity headers downstream — and Zen 403s requests missing it while identical ones carrying it pass (found via MITM: the header is present on every other call). Set explicitly in the provider wrapper, the compat patch, and both network guards.

- Support Zen API keys with anonymous fallback: `resolveZenApiKey` prefers a stored credential (`/login opencode-zen-free`), then `OPENCODE_API_KEY`, then `public`. Wrappers rebuild `Authorization` from the effective key so it can never mismatch. Anonymous stays the default; a key moves you to account quota when the anonymous tier rejects you.

- Env-gated request logging: `PI_OPENCODE_DIRECT_DEBUG=1` logs the outbound Zen identity (UA, session, auth presence, request shape) at each layer without ever logging content.

## 0.1.5

- Last-resort fetch guard: any other in-process `fetch` to `https://opencode.ai/zen/v1` (present or future Pi flows, e.g. compaction if rerouted off the provider) gets the same identity at the network edge. Strictly scoped to the Zen base URL, preserves a valid upstream session and an existing Authorization, reload-safe via pristine-original stash.
- Same coverage for non-fetch callers: `node:http`/`https` `request`/`get` targeting `opencode.ai/zen/v1` (axios / node-fetch style code in any extension or in-process MCP tool) get the identity injected across all header shapes (object, `Headers`, pair array). Other hosts pass through untouched. Not covered: separate processes (Hermes children, MCP stdio servers calling Zen themselves), direct `undici` imports, named-import capturers bound before load, WebSocket (unused by Zen transports).

## 0.1.4

- Fix `pi-hermes-memory` background-review direct transport (`Memory auto-review failed ... FreeTierError ... can only be used from within OpenCode`): the OpenCode `User-Agent` / `x-opencode-client` / `x-opencode-project` identity now lives on `provider.headers`, `model.headers`, and `auth.resolve()` headers, not only in the `stream()`/`streamSimple()` wrapper. Side-channels that use `modelRegistry.getApiKeyAndHeaders()` + `pi-ai/compat completeSimple` (which never call the wrapper) now pass the gate. Dynamic `x-opencode-session` / `x-opencode-request` / `Authorization` stay per-request in the wrapper.
- Zero-config memory side-channels: the extension also patches the global `pi-ai/compat` API registry at load so `completeSimple`/`streamSimple` calls that bypass Models send the full dynamic Zen identity (`Bearer public`, OpenCode `User-Agent` / `x-opencode-client` / `x-opencode-project`, per-session `x-opencode-session`, per-request `x-opencode-request`, encrypted-content fetch retry) for `opencode-zen-free` models only. No `llmModelOverride` / `childExtensionPaths` needed for the default direct transport. Deliberately no `xhigh` default on this path: compat omission stays `off`, preserving `llmThinkingOverride: off`. Reload-safe via pristine-original stash (no wrapper stacking).
- Note: the Hermes `pi -p` subprocess transport still spawns with `--no-extensions` + only Hermes loaded, so `opencode-zen-free/... not found` there needs `"childExtensionPaths": ["/path/to/pi-opencode-direct/src/index.ts"]` in `hermes-memory-config.json` — only relevant when direct fails or `reviewTransport` is forced to `subprocess`.

## 0.1.3

- Recover from OpenCode's free-tier `from within OpenCode` gate: send `Authorization: Bearer public`, the exact OpenCode `User-Agent` / `x-opencode-client` / `x-opencode-project` / `x-opencode-request` headers, and a structurally valid `ses_` session id (`12` hex + `14` base62) with a matching `prompt_cache_key`.

## 0.1.2

- Declare `@earendil-works/pi-ai` as a real dependency (pinned to the validated Pi) instead of peer-only. Pi installs with `--legacy-peer-deps`, which never auto-installs peers, so on machines where no sibling extension provides `pi-ai` the extension failed to load with `Cannot find module ... openai-completions.lazy`.

## 0.1.1

- Recover long sessions when Zen rotates backends: retry once without replayed `reasoning.encrypted_content` on `was not issued to this caller` / `could not be verified` 400s, dropping orphaned function-call ids to avoid pairing validation.

## 0.1.0

- Connect Pi directly to OpenCode Zen's anonymous free tier.
- Support Muse Spark images, configurable thinking, streaming, and native tool calls.
- Register other known free models through Pi's native Chat Completions transport.
- Refresh available models against Zen's public catalogue while retaining Pi's model metadata.
- Keep session routing stable without sending API credentials.
