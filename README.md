# omp-opencode-fix

OpenCode Zen's free models in [omp](https://github.com/can1357/oh-my-pi) through
native HTTP requests. No OpenCode installation, login, API key, server,
container, or proxy is required.

This is the omp port of `pi-opencode-direct`. The transport half is gone: omp
already streams, sends tools, and has an `openai-completions` /
`openai-responses` implementation, so the extension only supplies the identity
the Zen free tier checks and delegates the wire work to omp.

## Install

Requires omp 18.11.1 or newer (tested against 18.11.1) and Bun as the omp
runtime.

```sh
omp plugin install omp-opencode-fix     # published package
omp plugin link .                       # or a checkout, symlinked into omp
```

Restart omp, then select **OpenCode Zen Free** in `/model`:

```sh
omp --provider opencode-zen-free --model muse-spark-1.3-contributor-free
omp models opencode-zen-free            # the free roster
```

Every model in omp's bundled `opencode-zen` catalogue whose cost is zero and
whose wire API is `openai-completions` or `openai-responses` is registered:
`muse-spark-1.2/1.3-contributor-free` (Responses lane), plus the Chat
Completions free models (`longcat-2.5-preview-free`, `mimo-v2.6-flash-free`,
`nemotron-3.5-*`, `space-bunny-free`, `step-5-preview-free`, …).
Anthropic- and Google-lane free ids are out of scope, and paid models are never
registered. `fetchDynamicModels` refreshes the roster from
`GET /zen/v1/models`; ids omp's catalogue has not seen yet (for example
`deepseek-v4.1-flash-free`) are registered with conservative metadata until
official metadata ships.

## Credentials

Anonymous by default: the literal `public` bearer is sent and no credential is
read. Precedence is

1. a stored `/login opencode-zen-free` credential,
2. `OPENCODE_API_KEY`,
3. anonymous.

```sh
omp    # then: /login opencode-zen-free
```

## How it works

The extension registers a separate provider id (`opencode-zen-free`) because
omp's built-in `opencode-zen` overwrites `x-opencode-session` with the
conversation id (`applyInferenceHeaders` hardcodes that provider id), and the
gate rejects a UUID. A distinct id keeps omp's identity projection out of the
request; the extension then writes its own headers and delegates to omp's own
`streamSimple` with the model's real wire API.

What every request carries:

| Piece | Value |
| --- | --- |
| `baseUrl` | `https://opencode.ai/zen/v1` |
| `Authorization` | `Bearer public`, a stored Zen key, or `OPENCODE_API_KEY` |
| `x-opencode-session` | `ses_` + 12 hex + 14 base62, minted once per omp session |
| `x-opencode-client` | `cli` |
| `User-Agent` | `opencode/latest/2.0.26/cli` |
| `stream` | always `true` (omp streams every turn) |
| tools | the caller's tools, unrenamed |

Nothing else is rewritten. Caller tools, tool-call history, and system prompts
pass through untouched, so a tool call always resolves against the tool the
model was shown. The Pi version aliased a colliding `read` tool to `read_client`
and swapped the compaction system prompt; live probing (below) shows neither is
needed here, and both are exactly the kind of rewriting that breaks tool calls
once several prompts are mixed.

Requests with no tools at all (compaction, title generation, judgment) get a
single inert placeholder named `read` plus a one-line note telling the model not
to call it. The gate requires the name; nothing else about the definition is
checked.

Responses-lane models carry their catalogue `compat` object into the delegated
call. omp's OpenCode Responses handler dereferences `model.compat` while it
starts a session, and the model registry leaves that field undefined for
extension-registered models, so delegating a Responses model without it crashes
the turn before the request is sent. Chat Completions models are left as omp
resolved them: that handler builds its own compat when the field is absent.

Responses-lane turns can be rejected with
``400 reasoning `encrypted_content` was not issued to this caller`` when Zen
rotates the conversation to a backend that no longer holds the encryption key.
The provider retries that request once with stale `reasoning` items (and
orphaned `fc_*` ids) stripped, which the upstream accepts as a fresh session.

Set `OMP_OPENCODE_FREE_DEBUG=1` to log the outbound identity and request shape
to stderr. Content is never logged.

## Free-tier gate, live-probed 2026-10-16

Probes against `https://opencode.ai/zen/v1/chat/completions`, anonymous
(`Bearer public`), one variable per request:

| Request | Result |
| --- | --- |
| non-streaming, any headers/tools | `403 FreeTierError` |
| streaming, tools named `read` | `200` |
| streaming, `read` + `shell` | `200` |
| streaming, stub `read` (wrong description/schema) | `200` |
| streaming, `read`-less tool list | `403 FreeTierError` |
| streaming, `shell` only | `403 FreeTierError` |
| streaming, UUID or missing `x-opencode-session` | `403 FreeTierError` |
| streaming, `read`, 11 mixed system prompts + tool history | `200`, tool call intact |
| streaming, `read`, OpenCode summary prompt / omp summary prompt / 4000-char prompt | `200` |
| streaming, `read`, `tool_choice: "none"` / `"auto"` | `200` |
| streaming, `read`, `Authorization: Bearer <real Zen key>` | `200` |
| non-streaming, `read`, real Zen key | `403 FreeTierError` |
| `/zen/v1/responses`, `read`, `muse-spark-1.3-contributor-free` | `200` |
| `/zen/v1/responses`, no tools | `403 FreeTierError` |

So the gate checks streaming, one tool named `read`, and the session id's shape
and small counter. It does not check tool definitions, the user agent version,
`x-opencode-client`, `x-opencode-project`, `x-opencode-session-id`,
`x-session-affinity`, `X-Session-Id`, the system prompt, or the route
(`/zen/v1` and `/inference/v1` both answer). The extension sends only the
headers that were verified to work; the extra correlation headers cost a `401
Invalid credential` on `/inference/v1` and buy nothing.

Anonymous quota is shared per egress IP (Zen counts input + output + reasoning
tokens against a server-side trial bucket), so heavy anonymous traffic from one
address can exhaust it for every client behind it. Attach a key when that
happens.

## Development

```sh
npm ci --ignore-scripts
npm run verify                          # tsc + fixture tests + pack dry run

bun run test/live                       # optional: real free-tier requests
OPENCODE_FREE_MODEL=space-bunny-free bun run test/live.ts
```

`npm test` runs the unit suite under Bun (the omp runtime; Node cannot strip
types inside `node_modules`): the plugin entry (`plugin.test.ts`), the provider
(`provider.test.ts`), and the wire-fixture client tests (`opencode-client*.test.ts`).
Fixtures use an in-memory fetch and a stubbed SSE
body: no network, no model calls. `bun run test/live` sends real requests to the
anonymous tier (vision, streamed tool call, tool-result replay, and a tool-less
compaction-style request). Use the free tier lightly and follow the provider's
data-use policies.

## Standalone client (`src/opencode-client.ts`)

The same wire craft without omp: a zero-dependency client that recreates
opencode 1.19.0 requests byte-for-byte, recovered from an HTTP capture and
cross-checked against the request builder in the installed binary.

```ts
import {
	buildOpencodeRequest,
	buildResponsesBody,
	createMessageId,
	createSessionId,
	rawRequestBlock,    // exact wire bytes incl. Bun-appended headers
	sendOpencodeRequest,
} from "./src/opencode-client.ts";

const input = {
	lane: "responses" as const, // or "chat"
	sessionId: createSessionId(),
	userId: createMessageId(),
	providerId: "opencode",
	body: buildResponsesBody({
		model: "gpt-5.4-nano",
		input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		maxOutputTokens: 32000,
		include: ["reasoning.encrypted_content"],
		reasoning: { effort: "none", summary: "auto" },
	}),
};

const response = await sendOpencodeRequest(input); // streaming SSE passes through
console.log(rawRequestBlock(buildOpencodeRequest(input))); // inspect the exact wire bytes
```

Byte-level fixture tests prove the responses body equals the captured
3895-byte payload and the header block matches the capture line for line
(sorted app headers, then Bun's `Connection`/`Accept`/`Host`/
`Accept-Encoding`/`Content-Length`). To match opencode at the TLS layer too
(JA3/JA4), run the client under the same Bun runtime it fingerprints
(`runtime/bun/1.3.14`); fetch alone cannot control that.

## License

MIT. This is an independent extension, not an official OpenCode or omp package.
