/**
 * OpenCode Zen free tier as an omp provider.
 *
 * The free lane is gated upstream on three request properties (live-probed
 * 2026-10-16 against `https://opencode.ai/zen/v1`, see README):
 *
 * 1. the request streams (`stream: true`);
 * 2. the tool list contains a tool named `read`;
 * 3. `x-opencode-session` carries a `ses_` id whose 12-hex prefix decodes to a
 *    recent timestamp with a small counter.
 *
 * omp already streams every request and its own `read` tool satisfies (2), so
 * this module only has to mint (3) and keep the credential honest. Nothing else
 * is rewritten: caller tools, history, and system prompts pass through
 * untouched, so tool calls always resolve against the tool the model saw.
 * (omp's own `x-opencode-session` is a conversation UUID; the built-in
 * `opencode-zen` provider sends it verbatim, which the gate rejects.)
 *
 * Requests without any tool (compaction, title generation, judgment) get a
 * single inert `read` placeholder plus a one-line note so the gate passes.
 */

import { randomBytes } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/** Provider id in `/model`, `omp models`, and `--model`. */
export const PROVIDER_ID = "opencode-zen-free";
/** Extension-owned API id; built-in API names are reserved. */
export const ZEN_API = "opencode-zen-free-api";
/** Anonymous free lane (verified 200 with `Bearer public` + streaming). */
export const BASE_URL = "https://opencode.ai/zen/v1";

/** OpenCode v2 client fingerprint. The gate rejects the v1 `opencode/1.x` form. */
export const OPENCODE_USER_AGENT = "opencode/latest/2.0.26/cli";
export const OPENCODE_CLIENT = "cli";

/** Literal bearer the anonymous tier accepts. */
export const ANONYMOUS_API_KEY = "public";
/** Optional real Zen key: stored `/login` credential, then this env var, then anonymous. */
export const ZEN_API_KEY_ENV = "OPENCODE_API_KEY";

/** Tool name the free-tier gate requires in the request body. */
export const FREE_TIER_TOOL = "read";

/** Set `OMP_OPENCODE_FREE_DEBUG=1` to log Zen-bound request identity to stderr. */
export const DEBUG_ENV = "OMP_OPENCODE_FREE_DEBUG";

/** Wire APIs this provider serves; every other free model in the catalogue is skipped. */
export type ZenWireApi = "openai-completions" | "openai-responses";
const WIRE_APIS: readonly ZenWireApi[] = ["openai-completions", "openai-responses"];

/** `ses_` + 12 hex (descending timestamp) + 14 base62, as the OpenCode CLI mints. */
export const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** Headers every Zen request carries. Dynamic values are added per request. */
export function staticZenHeaders(): Record<string, string> {
	return {
		"User-Agent": OPENCODE_USER_AGENT,
		"x-opencode-client": OPENCODE_CLIENT,
	};
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;

/**
 * Map an omp session id to a valid OpenCode session id, stable for that session.
 *
 * The id is `ses_` + 12 hex + 14 base62, where the 12 hex are the low 48 bits of
 * `~(timestamp_ms * 0x1000 + counter)`. Live probing shows the gate accepts the
 * format with a small counter; the value is minted from the current clock with
 * one monotonic counter per millisecond, so a validator that also checks the
 * decoded timestamp accepts it. Values are cached per session so Zen's sticky
 * backend keeps routing the conversation to one instance (Responses-lane
 * reasoning replays are bound to that instance).
 */
const sessionHeaderCache = new Map<string, string>();
let sessionHeaderCounter = 0;
let sessionHeaderLastTimestamp = 0;

/** Session id used when the host passes none (auxiliary calls, tests). */
export const SESSION_FALLBACK_KEY = "process";

export function createDescendingSessionId(timestamp = Date.now()): string {
	if (timestamp !== sessionHeaderLastTimestamp) {
		sessionHeaderLastTimestamp = timestamp;
		sessionHeaderCounter = 0;
	}
	sessionHeaderCounter++;
	const current = BigInt(timestamp) * 0x1000n + BigInt(sessionHeaderCounter);
	const masked = ((-current - 1n) % (1n << 48n) + (1n << 48n)) % (1n << 48n);
	const hex = masked.toString(16).padStart(12, "0");
	let random = "";
	const bytes = randomBytes(14);
	for (let i = 0; i < 14; i++) random += BASE62[bytes[i] % 62];
	return `ses_${hex}${random}`;
}

export function sessionHeader(sessionId?: string): string {
	const key = sessionId && sessionId.length > 0 ? sessionId : SESSION_FALLBACK_KEY;
	const cached = sessionHeaderCache.get(key);
	if (cached) return cached;
	const created = createDescendingSessionId();
	sessionHeaderCache.set(key, created);
	return created;
}

/** Test hook: clear the per-session cache. */
export function __clearSessionHeaderCacheForTests(): void {
	sessionHeaderCache.clear();
	sessionHeaderCounter = 0;
	sessionHeaderLastTimestamp = 0;
}

/**
 * Decode the 48-bit payload a generated session id carries: the low 12 bits are
 * the counter, the rest is the low 36 bits of the millisecond timestamp (the
 * timestamp occupies 36 bits once shifted by the counter's 12). Exposed for
 * tests; the gate reads the same layout.
 */
export function sessionPayload(sessionId: string): { counter: number; timeLow36: number } {
	const prefix = BigInt(`0x${sessionId.slice(4, 16)}`);
	const decoded = ~prefix & SESSION_PREFIX_MASK;
	return { counter: Number(decoded & 0xfffn), timeLow36: Number(decoded >> 12n) };
}

/**
 * Credential precedence: stored `/login` credential (the host passes it as
 * `options.apiKey`), then `OPENCODE_API_KEY`, then the anonymous literal.
 */
export function resolveZenApiKey(optionKey: unknown): string {
	const stored = typeof optionKey === "string" ? optionKey.trim() : "";
	if (stored && stored !== ANONYMOUS_API_KEY && stored !== ZEN_API_KEY_ENV) return stored;
	const env = process.env[ZEN_API_KEY_ENV]?.trim();
	return env && env.length > 0 ? env : ANONYMOUS_API_KEY;
}

/**
 * Inert placeholder for requests that carry no tools. The gate only checks the
 * name, so the schema stays minimal and the tool is never meant to run.
 */
export const FREE_TIER_READ_TOOL: Tool = {
	name: FREE_TIER_TOOL,
	description: "Placeholder required by the upstream free tier. It does nothing; do not call it.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	} as unknown as Tool["parameters"],
	strict: false,
};

/** Note that keeps the model away from the placeholder. */
export const FREE_TIER_PLACEHOLDER_NOTE =
	"Do not call the `read` tool; it is a placeholder that does nothing. Use the other tools you have been given instead.";

/**
 * Guarantee the gate's required tool name without touching anything else. When
 * the caller already declares `read` (every ordinary omp turn does) the context
 * is returned unchanged: no aliasing, no renaming, no history rewriting.
 */
export function ensureFreeTierTools(context: Context): Context {
	const tools = context.tools ?? [];
	if (tools.some(tool => tool.name === FREE_TIER_TOOL)) return context;
	return {
		...context,
		tools: [...tools, FREE_TIER_READ_TOOL],
		systemPrompt: [...(context.systemPrompt ?? []), FREE_TIER_PLACEHOLDER_NOTE],
	};
}

/* ------------------------------------------------------------------------- *
 * Model catalogue
 * ------------------------------------------------------------------------- */

interface ZenModelEntry {
	config: ProviderModelConfig;
	wireApi: ZenWireApi;
}

function wireApiOf(model: Model<Api> | { api?: string | undefined }, id: string): ZenWireApi | undefined {
	if (model.api === "openai-completions") return "openai-completions";
	if (model.api === "openai-responses") return "openai-responses";
	if (typeof model.api === "string" && model.api.length > 0) return undefined;
	// Unknown ids: the Muse Spark lane is the only Responses model family.
	return id.startsWith("muse-spark-") ? "openai-responses" : "openai-completions";
}

/** "step-5-preview-free" -> "Step 5 Preview Free". */
export function prettyFreeName(id: string): string {
	return id
		.split("/")
		.pop()!
		.split(/[-_:]+/)
		.map(word => (/^[a-z]+$/i.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
		.join(" ");
}

/** Ids that look free but are not chat models (classifier and friends). */
const NON_CHAT_FREE_PREFIXES = ["jev-"];

/** True for a free-looking id the bundled catalogue does not know. */
export function isUnknownFreeId(id: unknown): boolean {
	if (typeof id !== "string" || id.length === 0) return false;
	if (NON_CHAT_FREE_PREFIXES.some(prefix => id.startsWith(prefix))) return false;
	return /(^|[/:_-])free([/:_-]|$)/i.test(id) || /-free$/i.test(id);
}

/**
 * Conservative entry for a free model Zen serves that omp's bundled catalogue
 * has not seen yet. `pi update --models` (or the next omp release) replaces it
 * once official metadata ships.
 */
export function syntheticFreeModel(id: string): ProviderModelConfig {
	return {
		id,
		name: prettyFreeName(id),
		api: ZEN_API,
		kind: "chat",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	};
}

function toProviderModel(model: Model<Api>): ZenModelEntry | undefined {
	const wireApi = wireApiOf(model, model.id);
	if (!wireApi || !WIRE_APIS.includes(wireApi)) return undefined;
	const { cost } = model;
	if (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0) return undefined;
	return {
		wireApi,
		config: {
			id: model.id,
			name: model.name,
			api: ZEN_API,
			kind: "chat",
			reasoning: model.reasoning,
			...(model.thinking ? { thinking: model.thinking } : {}),
			input: [...model.input],
			...(model.supportsTools === undefined ? {} : { supportsTools: model.supportsTools }),
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: model.contextWindow ?? 262_144,
			maxTokens: model.maxTokens ?? 32_768,
			headers: { ...(model.headers ?? {}), ...staticZenHeaders() },
			...(model.compat ? { compat: model.compat } : {}),
		},
	};
}

/** Free, chat-capable models from omp's bundled `opencode-zen` catalogue. */
export function zenModelEntries(): ZenModelEntry[] {
	try {
		return getBundledModels("opencode-zen")
			.map(toProviderModel)
			.filter((entry): entry is ZenModelEntry => entry !== undefined);
	} catch {
		return [];
	}
}

/** Static `models` list handed to `registerProvider`. */
export function zenModels(): ProviderModelConfig[] {
	return zenModelEntries().map(entry => entry.config);
}

/** Wire API for a model id: catalogue metadata first, id family second. */
export function wireApiFor(modelId: string): ZenWireApi {
	const known = zenModelEntries().find(entry => entry.config.id === modelId);
	return known?.wireApi ?? wireApiOf({}, modelId) ?? "openai-completions";
}

/** Bundled compat objects by model id; the catalogue ships one per known model. */
let bundledCompatCache: Map<string, Model<Api>["compat"]> | undefined;

function bundledCompat(id: string): Model<Api>["compat"] | undefined {
	if (!bundledCompatCache) {
		const cache = new Map<string, Model<Api>["compat"]>();
		for (const model of getBundledModels("opencode-zen") as Model<Api>[]) {
			if (model.compat) cache.set(model.id, model.compat);
		}
		bundledCompatCache = cache;
	}
	return bundledCompatCache.get(id);
}

/** Template for a Responses-lane id the catalogue has not seen yet. */
function responsesCompatTemplate(): Model<Api>["compat"] | undefined {
	for (const model of getBundledModels("opencode-zen") as Model<Api>[]) {
		if (model.compat && wireApiOf(model, model.id) === "openai-responses") return model.compat;
	}
	return undefined;
}

/**
 * Compat for the model handed to omp's transport. omp's OpenCode Responses
 * handler dereferences `model.compat` at entry (`nativeHistoryReplayWarmed`,
 * `supportsImageDetailOriginal`) without a guard, while the Chat Completions
 * handler resolves its own compat when the field is missing. The registry hands
 * extension models an undefined compat, so the Responses lane has to supply
 * one; the catalogue value is what the built-in `opencode-zen` provider sends
 * for the same model. The Completions lane is left exactly as omp resolved it.
 */
export function delegatedCompat(model: Model<Api>, wireApi: ZenWireApi): Model<Api>["compat"] | undefined {
	if (model.compat) return model.compat;
	if (wireApi !== "openai-responses") return undefined;
	const compat = bundledCompat(model.id) ?? responsesCompatTemplate();
	// An empty object is still a guard: the handler's compat reads tolerate
	// absent keys, they do not tolerate an absent compat.
	return compat ?? ({} as Model<Api>["compat"]);
}

/**
 * Live catalogue refresh. The host caches the result (SQLite, provider-keyed)
 * and keeps the static list as fallback, so a failed refresh never empties the
 * picker. Unknown free ids are registered with conservative metadata.
 */
export async function fetchFreeModels(apiKey: string | undefined): Promise<readonly ProviderModelConfig[]> {
	const known = zenModelEntries();
	const knownById = new Map(known.map(entry => [entry.config.id, entry]));
	const apiKeyValue = resolveZenApiKey(apiKey);
	const response = await fetch(`${BASE_URL}/models`, {
		signal: AbortSignal.timeout(5_000),
		headers: {
			...(apiKeyValue === ANONYMOUS_API_KEY ? {} : { Authorization: `Bearer ${apiKeyValue}` }),
			"User-Agent": OPENCODE_USER_AGENT,
		},
	});
	if (!response.ok) throw new Error(`Zen model catalogue: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new Error("Zen model catalogue: invalid payload");
	}
	const available = new Set(
		payload.data.map((model: unknown) =>
			model && typeof model === "object" && "id" in model ? model.id : undefined,
		),
	);
	const listed = known.filter(entry => available.has(entry.config.id)).map(entry => entry.config);
	const unknown = [...available]
		.filter((id): id is string => typeof id === "string" && !knownById.has(id) && isUnknownFreeId(id))
		.sort();
	return [...listed, ...unknown.map(syntheticFreeModel)];
}

/* ------------------------------------------------------------------------- *
 * Response-lane rotation retry
 * ------------------------------------------------------------------------- */

/**
 * Zen routes `x-opencode-session` to a sticky backend so `reasoning.encrypted_content`
 * replays. After idle expiry or a long turn Zen can move the session to an
 * instance without the encryption key, and the replay is rejected with
 * 400 ``reasoning `encrypted_content` was not issued to this caller``.
 */
export function isEncryptedContentError(status: number, bodyText: string): boolean {
	if (status !== 400) return false;
	return /encrypted[_ ]content/i.test(bodyText);
}

/** `type` field of a Responses input item, when the item carries one. */
function itemType(item: unknown): unknown {
	return item && typeof item === "object" && "type" in item ? item.type : undefined;
}

/** `id` field of a Responses input item, when the item carries a string one. */
function itemId(item: unknown): string | undefined {
	if (!item || typeof item !== "object" || !("id" in item)) return undefined;
	return typeof item.id === "string" ? item.id : undefined;
}

/**
 * Drop stale Responses `reasoning` items so the retry looks like a fresh
 * session, which Zen always accepts. Function-call ids go too (`call_id` is
 * kept): OpenAI requires `fc_*` ids to be paired with the original `rs_*`
 * reasoning items. Returns null when there is nothing to strip.
 */
export function stripStaleReasoning(payload: unknown): unknown | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("input" in payload)) return null;
	const input = payload.input;
	if (!Array.isArray(input)) return null;
	if (!input.some(item => itemType(item) === "reasoning")) return null;
	const nextInput = input
		.filter(item => itemType(item) !== "reasoning")
		.map(item => {
			const type = itemType(item);
			if ((type === "function_call" || type === "custom_tool_call") && itemId(item) !== undefined) {
				const { id: _dropped, ...rest } = item as Record<string, unknown>;
				return rest;
			}
			return item;
		});
	return { ...payload, input: nextInput };
}

/** String body of a fetch init, when the caller supplied one. */
function requestBody(init: unknown): unknown {
	if (!init || typeof init !== "object" || !("body" in init)) return undefined;
	return init.body;
}

/** Wrap fetch with a single retry that drops stale reasoning on a Zen rotation. */
export function withEncryptedContentFallback(inner?: FetchImpl): FetchImpl {
	const base: FetchImpl = inner ?? (globalThis.fetch as FetchImpl);
	return (async (url: unknown, init?: unknown) => {
		const call = base as unknown as (input: unknown, options?: unknown) => Promise<Response>;
		const first = await call(url, init);
		if (first.status !== 400) return first;
		let text = "";
		try {
			text = await first.clone().text();
		} catch {
			return first;
		}
		if (!isEncryptedContentError(first.status, text)) return first;
		let parsed: unknown;
		try {
			const raw = requestBody(init);
			if (typeof raw !== "string") return first;
			parsed = JSON.parse(raw);
		} catch {
			return first;
		}
		const stripped = stripStaleReasoning(parsed);
		if (!stripped) return first;
		return call(url, { ...(init && typeof init === "object" ? init : {}), body: JSON.stringify(stripped) });
	}) as FetchImpl;
}

/* ------------------------------------------------------------------------- *
 * Request build + streaming
 * ------------------------------------------------------------------------- */

/** Everything the delegated transport needs, plus the identity it must carry. */
export interface ZenRequest {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions;
	/** omp session id this request belongs to (undefined for auxiliary calls). */
	sessionId?: string;
	/** Minted OpenCode session id sent as `x-opencode-session`. */
	opencodeSession: string;
	apiKey: string;
}

/**
 * Build the delegated model/context/options triple. The bundled openai transport
 * does the wire work; this only rewrites identity: Zen base URL, wire API,
 * OpenCode fingerprint headers, credential, and the rotation retry.
 */
export function buildZenRequest(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): ZenRequest {
	const apiKey = resolveZenApiKey(options?.apiKey);
	const opencodeSession = sessionHeader(options?.sessionId);
	const headers: Record<string, string> = {
		...(options?.headers ?? {}),
		...staticZenHeaders(),
		"x-opencode-session": opencodeSession,
		Authorization: `Bearer ${apiKey}`,
	};
	const wireApi = wireApiFor(model.id);
	const compat = delegatedCompat(model, wireApi);
	return {
		model: {
			...model,
			api: wireApi,
			provider: PROVIDER_ID,
			baseUrl: BASE_URL,
			headers: { ...(model.headers ?? {}), ...staticZenHeaders() },
			...(compat ? { compat } : {}),
		},
		context: ensureFreeTierTools(context),
		options: {
			...(options ?? {}),
			apiKey,
			headers,
			fetch: withEncryptedContentFallback(options?.fetch),
		},
		sessionId: options?.sessionId,
		opencodeSession,
		apiKey,
	};
}

function debugLog(message: string): void {
	try {
		if (process.env[DEBUG_ENV] === "1") console.error(`[omp-opencode-free] ${message}`);
	} catch {
		// Logging must never break a request.
	}
}

/** Shape summary for `OMP_OPENCODE_FREE_DEBUG=1`; sizes only, never content. */
export function shapeSummary(context: Context, options: SimpleStreamOptions | undefined): string {
	const messages = Array.isArray(context.messages) ? context.messages : [];
	let characters = 0;
	for (const message of messages) {
		characters += JSON.stringify(message)?.length ?? 0;
		if (characters > 10_000_000) break;
	}
	return `msgs=${messages.length} chars~${characters} tools=${context.tools?.length ?? 0} reasoning=${String(options?.reasoning ?? "(default)")}`;
}

/**
 * Custom-API transport: identity-bearing Zen request, delegated to omp's own
 * openai-completions / openai-responses implementation so streaming, tool
 * calls, reasoning, usage, and aborts behave exactly as they do for a built-in
 * provider.
 */
export function zenStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const request = buildZenRequest(model, context, options);
	debugLog(
		`session=${request.opencodeSession.slice(0, 17)}... auth=${request.apiKey === ANONYMOUS_API_KEY ? "anonymous" : "key"} api=${String(request.model.api)} ${shapeSummary(request.context, request.options)}`,
	);
	return streamSimple(request.model, request.context, request.options);
}
