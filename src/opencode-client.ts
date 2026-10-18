/**
 * Standalone OpenCode HTTP client: recreates opencode 1.19.0 inference
 * requests byte-for-byte (headers + JSON body), recovered from the
 * `opencode.xml` HTTP capture (2026-10-18) and cross-checked against the
 * request builder bundled in the installed 1.19.0 binary.
 *
 * Wire facts (capture Http 312, responses lane, fully captured):
 *
 * ```http
 * POST /inference/openai/v1/responses HTTP/1.1
 * Authorization: Bearer <key>          // redacted in the XML
 * Content-Type: application/json
 * User-Agent: opencode/1.19.0 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14
 * x-opencode-client: cli
 * x-opencode-project: global
 * x-opencode-request: msg_14d8075ca001W5wUFTMEsrvz3H
 * x-opencode-session: ses_eb27f8a80ffeRXsK4FsLEg1Zx9
 * x-opencode-session-id: ses_eb27f8a80ffeRXsK4FsLEg1Zx9
 * Connection: keep-alive               // Bun runtime appends the rest
 * Accept: *\u002F*                     // literal star-slash-star (escaped for this comment)
 * Host: opencode.ai
 * Accept-Encoding: gzip, deflate
 * Content-Length: 3895
 * ```
 *
 * - App headers reach the wire sorted by code unit (uppercase first) — the
 *   capture shows exactly that; `buildOpencodeRequest` sorts to match, so the
 *   output survives any transport that preserves insertion order.
 * - `Connection`/`Accept`/`Host`/`Accept-Encoding`/`Content-Length` are added
 *   by Bun's HTTP client in that order; `rawRequestBlock` reproduces them for
 *   raw sockets and byte-level tests.
 * - Body is compact `JSON.stringify` output (3895 bytes = UTF-8 byte length
 *   of the 3871-char captured body). Key order per lane:
 *   - responses: `model, input, max_output_tokens, store, include, reasoning,
 *     stream` (undefined fields dropped, `store: false`, `stream: true`);
 *   - chat: `model, max_tokens, messages, tools, tool_choice, stream`
 *     (tools sorted by function name via `localeCompare`, as the binary does).
 * - IDs: `ses_` descending + `msg_` ascending, `ts*0x1000+counter` (bitwise-not
 *   when descending), low 48 bits as 12 hex + 14 base62 chars.
 * - User-Agent: `opencode/<v>` from the builder, then the SDK transport
 *   appends `ai-sdk/provider-utils/<v>` and `runtime/<rt>` space-joined.
 *   Per-lane SDK versions as captured: 4.0.40 responses, 4.0.23 chat.
 * - TLS: opencode runs Bun; to look identical at the TLS layer (JA3/JA4),
 *   run this client under Bun as well. fetch alone cannot fix that.
 * - Credential: the capture redacts the bearer; the binary's provider loader
 *   defaults `apiKey: "public"` with `OPENCODE_API_KEY` as env override.
 * - Chat bodies >~24KB are truncated in the capture (declared 80538/81124
 *   bytes); the chat key order comes from the binary's getArgs assembly.
 *
 * Zero dependencies: works in Bun, Node 22+, or any fetch runtime.
 */

export const OPENCODE_HOST = "https://opencode.ai";
/** Base path exactly as captured (not the `zen/v1` catalogue api value). */
export const INFERENCE_BASE = `${OPENCODE_HOST}/inference/openai/v1`;
export const RESPONSES_PATH = "/responses";
export const CHAT_COMPLETIONS_PATH = "/chat/completions";

/** Client version in the capture; the UA base is `opencode/<version>`. */
export const OPENCODE_VERSION = "1.19.0";
/** Per-lane SDK suffixes exactly as captured. */
export const PROVIDER_UTILS_VERSIONS = {
	responses: "4.0.40",
	chat: "4.0.23",
} as const;
export const RUNTIME_FINGERPRINT = "bun/1.3.14";

export const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";
export const OPENCODE_CLIENT_ENV = "OPENCODE_CLIENT";
/** Bearer the provider loader sends when no key is configured. */
export const ANONYMOUS_API_KEY = "public";
/** Project id opencode sends when no project is open (as captured). */
export const GLOBAL_PROJECT = "global";

export type OpencodeLane = "responses" | "chat";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/* ------------------------------------------------------------------------- *
 * IDs: `ses_` (descending) + `msg_` (ascending), one shared counter like the
 * bundled `tA()` (`now = ts_ms * 0x1000 + counter`, bitwise-not when
 * descending, low 48 bits as 12 hex, plus 14 base62 chars from random bytes).
 * ------------------------------------------------------------------------- */

let lastTimestamp = 0;
let counter = 0;

/** Test hook: reset the shared timestamp/counter state. */
export function __resetIdStateForTests(): void {
	lastTimestamp = 0;
	counter = 0;
}

export function createRawId(descending: boolean, timestamp = Date.now(), random?: Uint8Array): string {
	if (timestamp !== lastTimestamp) {
		lastTimestamp = timestamp;
		counter = 0;
	}
	counter++;
	const now = BigInt(timestamp) * 0x1000n + BigInt(counter);
	const value = descending ? ~now : now;
	let hex = "";
	for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
	const bytes = random ?? crypto.getRandomValues(new Uint8Array(14));
	let tail = "";
	for (let i = 0; i < 14; i++) tail += BASE62[bytes[i] % 62];
	return hex + tail;
}

/** Session id for `x-opencode-session` / `x-opencode-session-id`. */
export function createSessionId(timestamp?: number, random?: Uint8Array): string {
	return `ses_${createRawId(true, timestamp, random)}`;
}

/** User/message id for `x-opencode-request`. */
export function createMessageId(timestamp?: number, random?: Uint8Array): string {
	return `msg_${createRawId(false, timestamp, random)}`;
}

/* ------------------------------------------------------------------------- *
 * Headers
 * ------------------------------------------------------------------------- */

export interface OpencodeHeaderInput {
	/** `ses_…` id; sent as both `x-opencode-session-id` and `x-opencode-session`. */
	sessionId: string;
	/** `msg_…` id; sent as `x-opencode-request`. */
	userId: string;
	/** `opencode*` takes the `x-opencode-*` branch, anything else the affinity branch. */
	providerId: string;
	/** Omitted when unknown. Defaults to `"global"` like the real client. */
	projectId?: string;
	parentSessionId?: string;
	/** Defaults to `OPENCODE_CLIENT` env, then `"cli"` (`"acp"` under acp). */
	client?: string;
	/** UA base version. Defaults to the captured `1.19.0`. */
	version?: string;
	/** Per-model headers; win over built-ins, like `...e.model.headers`. */
	modelHeaders?: Record<string, string>;
	/** Plugin `chat.headers` hook result; wins over everything. */
	extraHeaders?: Record<string, string>;
}

export function buildOpencodeHeaders(input: OpencodeHeaderInput): Record<string, string> {
	const client = input.client ?? process.env[OPENCODE_CLIENT_ENV] ?? "cli";
	const baseAgent = `opencode/${input.version ?? OPENCODE_VERSION}`;
	const projectId = input.projectId ?? GLOBAL_PROJECT;
	const headers: Record<string, string> = { "x-opencode-session-id": input.sessionId };
	if (input.parentSessionId) headers["x-opencode-parent-session-id"] = input.parentSessionId;
	if (input.providerId.startsWith("opencode")) {
		if (projectId) headers["x-opencode-project"] = projectId;
		headers["x-opencode-session"] = input.sessionId;
		headers["x-opencode-request"] = input.userId;
		headers["x-opencode-client"] = client;
		headers["User-Agent"] = baseAgent;
	} else {
		headers["x-session-affinity"] = input.sessionId;
		headers["X-Session-Id"] = input.sessionId;
		headers["User-Agent"] = baseAgent;
	}
	if (input.parentSessionId) headers["x-parent-session-id"] = input.parentSessionId;
	return { ...headers, ...input.modelHeaders, ...input.extraHeaders };
}

/** SDK transport layer: appends `ai-sdk/provider-utils/<v> runtime/<rt>` to the UA. */
export function withSdkUserAgent(
	headers: Record<string, string>,
	sdkVersion: string,
	runtime = RUNTIME_FINGERPRINT,
): Record<string, string> {
	const base = headers["User-Agent"] ?? "";
	const agent = [base, `ai-sdk/provider-utils/${sdkVersion}`, `runtime/${runtime}`]
		.filter(part => part.length > 0)
		.join(" ");
	return { ...headers, "User-Agent": agent };
}

/**
 * Code-unit sort, matching how the capture reached the wire (uppercase names
 * before lowercase: Authorization, Content-Type, User-Agent, x-opencode-*).
 */
export function sortHeaders(headers: Record<string, string>): Record<string, string> {
	const sorted: Record<string, string> = {};
	for (const name of Object.keys(headers).sort()) sorted[name] = headers[name];
	return sorted;
}

/* ------------------------------------------------------------------------- *
 * Bodies: exact key order per lane, compact JSON, undefined dropped
 * ------------------------------------------------------------------------- */

export interface ResponsesBodyInput {
	model: string;
	/** Responses wire items (`{role:"developer"|"user"|"assistant"|…}`), passed through. */
	input: readonly unknown[];
	maxOutputTokens?: number;
	include?: readonly string[];
	reasoning?: { effort: string; summary: string };
	/** Defaults to `false` (`store:!1` in the binary). */
	store?: boolean;
}

/** Responses lane body: `model, input, max_output_tokens, store, include, reasoning, stream`. */
export function buildResponsesBody(input: ResponsesBodyInput): Record<string, unknown> {
	return {
		model: input.model,
		input: input.input,
		...(input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens }),
		store: input.store ?? false,
		...(input.include === undefined ? {} : { include: [...input.include] }),
		...(input.reasoning === undefined ? {} : { reasoning: { effort: input.reasoning.effort, summary: input.reasoning.summary } }),
		stream: true,
	};
}

/** Wire tool shape for the chat lane: `{"type":"function","function":{"name":…}}`. */
export interface ChatWireTool {
	type?: string;
	function?: { name?: string };
	[key: string]: unknown;
}

export interface ChatBodyInput {
	model: string;
	messages: readonly unknown[];
	maxOutputTokens?: number;
	/** Sorted by function name (`localeCompare`) like the binary's tool map. */
	tools?: readonly ChatWireTool[];
	toolChoice?: unknown;
}

function toolName(tool: ChatWireTool): string {
	if (tool && typeof tool === "object" && "function" in tool && tool.function && typeof tool.function === "object") {
		const fn = tool.function;
		if ("name" in fn && typeof fn.name === "string") return fn.name;
	}
	return "";
}

/** Chat lane body: `model, max_tokens, messages, tools, tool_choice, stream`. */
export function buildChatBody(input: ChatBodyInput): Record<string, unknown> {
	const tools = input.tools === undefined ? undefined : [...input.tools].sort((a, b) => toolName(a).localeCompare(toolName(b)));
	return {
		model: input.model,
		...(input.maxOutputTokens === undefined ? {} : { max_tokens: input.maxOutputTokens }),
		messages: input.messages,
		...(tools === undefined ? {} : { tools }),
		...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
		stream: true,
	};
}

/* ------------------------------------------------------------------------- *
 * Request
 * ------------------------------------------------------------------------- */

/** Credential precedence: explicit key, then `OPENCODE_API_KEY`, then `public`. */
export function resolveApiKey(explicit?: string): string {
	const given = explicit?.trim();
	if (given) return given;
	return process.env[OPENCODE_API_KEY_ENV]?.trim() || ANONYMOUS_API_KEY;
}

export function opencodeUrl(lane: OpencodeLane, base = INFERENCE_BASE): string {
	return base + (lane === "responses" ? RESPONSES_PATH : CHAT_COMPLETIONS_PATH);
}

export interface OpencodeRequestInput extends OpencodeHeaderInput {
	lane: OpencodeLane;
	/** Body object (e.g. from `buildResponsesBody`/`buildChatBody`), compact-serialized. */
	body: unknown;
	apiKey?: string;
	/** Defaults to the captured per-lane SDK version. */
	sdkVersion?: string;
	runtime?: string;
	baseUrl?: string;
}

export interface OpencodeHttpRequest {
	url: string;
	method: "POST";
	/** Sorted app headers (capture order). */
	headers: Record<string, string>;
	body: string;
}

export function buildOpencodeRequest(input: OpencodeRequestInput): OpencodeHttpRequest {
	const headers = withSdkUserAgent(
		buildOpencodeHeaders(input),
		input.sdkVersion ?? PROVIDER_UTILS_VERSIONS[input.lane],
		input.runtime,
	);
	headers.Authorization = `Bearer ${resolveApiKey(input.apiKey)}`;
	headers["Content-Type"] = "application/json";
	return {
		url: opencodeUrl(input.lane, input.baseUrl),
		method: "POST",
		headers: sortHeaders(headers),
		body: JSON.stringify(input.body),
	};
}

/**
 * Exact wire bytes: request line + sorted app headers + the runtime-appended
 * `Connection`, `Accept`, `Host`, `Accept-Encoding`, `Content-Length` (capture
 * order), CRLF line endings, body included. Used by the byte-level fixture
 * tests and by raw-socket transports.
 */
export function rawRequestBlock(request: OpencodeHttpRequest): string {
	const url = new URL(request.url);
	const lines = [`${request.method} ${url.pathname} HTTP/1.1`];
	for (const [name, value] of Object.entries(request.headers)) lines.push(`${name}: ${value}`);
	lines.push("Connection: keep-alive");
	lines.push("Accept: */*");
	lines.push(`Host: ${url.host}`);
	lines.push("Accept-Encoding: gzip, deflate");
	lines.push(`Content-Length: ${new TextEncoder().encode(request.body).length}`);
	return `${lines.join("\r\n")}\r\n\r\n${request.body}`;
}

export type OpencodeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<
	Response
>;

/** Send with an injected fetch (streaming responses pass through untouched). */
export async function sendOpencodeRequest(input: OpencodeRequestInput, fetchImpl: OpencodeFetch = fetch): Promise<Response> {
	const { url, method, headers, body } = buildOpencodeRequest(input);
	return fetchImpl(url, { method, headers, body });
}
