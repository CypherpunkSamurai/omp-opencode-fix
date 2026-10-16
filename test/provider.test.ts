/**
 * Fixture tests for the omp OpenCode Zen free provider.
 *
 * `test/live.ts` is the opt-in network check; everything here runs offline with
 * an in-memory fetch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

import {
	ANONYMOUS_API_KEY,
	BASE_URL,
	FREE_TIER_PLACEHOLDER_NOTE,
	FREE_TIER_TOOL,
	OPENCODE_CLIENT,
	OPENCODE_USER_AGENT,
	PROVIDER_ID,
	SESSION_FALLBACK_KEY,
	SESSION_ID_PATTERN,
	ZEN_API,
	ZEN_API_KEY_ENV,
	__clearSessionHeaderCacheForTests,
	buildZenRequest,
	createDescendingSessionId,
	ensureFreeTierTools,
	fetchFreeModels,
	isEncryptedContentError,
	isUnknownFreeId,
	prettyFreeName,
	resolveZenApiKey,
	sessionHeader,
	sessionPayload,
	stripStaleReasoning,
	syntheticFreeModel,
	wireApiFor,
	withEncryptedContentFallback,
	zenModelEntries,
	zenModels,
	zenStreamSimple,
} from "../src/provider.ts";

/** Free chat model from omp's own catalogue, shaped as the registry would build it. */
function catalogueModel(id = "muse-spark-1.3-contributor-free"): Model<Api> {
	const model = getBundledModels("opencode-zen").find(candidate => candidate.id === id);
	assert.ok(model, `catalogue model ${id} is missing`);
	return model;
}

function registryModel(id: string): Model<Api> {
	const entry = zenModelEntries().find(candidate => candidate.config.id === id);
	assert.ok(entry, `registered model ${id} is missing`);
	return {
		...catalogueModel(id),
		provider: PROVIDER_ID,
		api: ZEN_API,
		baseUrl: BASE_URL,
		// omp's registry drops the compat object for extension-registered models.
		compat: undefined,
	};
}

const readTool = {
	name: "read",
	description: "omp read",
	parameters: { type: "object", properties: { path: { type: "string" } } },
};

function sseResponse(frames: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: unknown): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "mimo-v2.6-flash-free",
		choices: [{ index: 0, delta, finish_reason: null }],
	})}\n\n`;
}

test("session ids match the gate grammar and carry a recent timestamp", () => {
	__clearSessionHeaderCacheForTests();
	const before = Date.now();
	const id = createDescendingSessionId();
	assert.match(id, SESSION_ID_PATTERN);
	const payload = sessionPayload(id);
	assert.equal(payload.timeLow36, before % 2 ** 36, "the minted timestamp is the current clock");
	assert.ok(payload.timeLow36 <= Date.now() % 2 ** 36);
	assert.ok(payload.counter >= 1 && payload.counter <= 16, `counter ${payload.counter} is outside the accepted range`);
});

test("session header is stable per session and distinct between sessions", () => {
	__clearSessionHeaderCacheForTests();
	const first = sessionHeader("session-a");
	assert.equal(first, sessionHeader("session-a"));
	assert.notEqual(first, sessionHeader("session-b"));
	assert.equal(sessionHeader(undefined), sessionHeader(SESSION_FALLBACK_KEY));
	assert.match(first, SESSION_ID_PATTERN);
});

test("tool lists that already declare read pass through untouched", () => {
	const context: Context = {
		systemPrompt: ["main system prompt"],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		tools: [readTool, { name: "bash", description: "omp bash", parameters: {} }, { name: "read_client", description: "alias", parameters: {} }],
	};
	const next = ensureFreeTierTools(context);
	assert.equal(next, context);
	assert.deepEqual(
		next.tools?.map(tool => tool.name),
		["read", "bash", "read_client"],
	);
	assert.deepEqual(next.systemPrompt, ["main system prompt"]);
});

test("tool-less requests gain one inert read placeholder plus the note", () => {
	const context: Context = { messages: [{ role: "user", content: "summarize", timestamp: 0 }] };
	const next = ensureFreeTierTools(context);
	assert.equal(next.tools?.length, 1);
	assert.equal(next.tools?.[0]?.name, FREE_TIER_TOOL);
	assert.match(next.tools?.[0]?.description ?? "", /placeholder/i);
	assert.deepEqual(next.systemPrompt, [FREE_TIER_PLACEHOLDER_NOTE]);
	assert.equal(context.tools, undefined, "the caller's context must not be mutated");
});

test("requests whose tools lack read keep every caller tool by name", () => {
	const context: Context = {
		messages: [{ role: "user", content: "judge", timestamp: 0 }],
		tools: [{ name: "submit_judgment", description: "judge", parameters: {} }],
	};
	const next = ensureFreeTierTools(context);
	assert.deepEqual(
		next.tools?.map(tool => tool.name),
		["submit_judgment", FREE_TIER_TOOL],
	);
});

test("key precedence is stored credential, then environment, then anonymous", () => {
	const previous = process.env[ZEN_API_KEY_ENV];
	try {
		delete process.env[ZEN_API_KEY_ENV];
		assert.equal(resolveZenApiKey("sk-stored"), "sk-stored");
		assert.equal(resolveZenApiKey(ANONYMOUS_API_KEY), ANONYMOUS_API_KEY);
		assert.equal(resolveZenApiKey(undefined), ANONYMOUS_API_KEY);
		process.env[ZEN_API_KEY_ENV] = "sk-env";
		assert.equal(resolveZenApiKey(undefined), "sk-env");
		assert.equal(resolveZenApiKey(ANONYMOUS_API_KEY), "sk-env");
		assert.equal(resolveZenApiKey("sk-stored"), "sk-stored", "a stored credential outranks the environment");
	} finally {
		if (previous === undefined) delete process.env[ZEN_API_KEY_ENV];
		else process.env[ZEN_API_KEY_ENV] = previous;
	}
});

test("built request carries the free-tier identity and keeps caller inputs", () => {
	__clearSessionHeaderCacheForTests();
	const model = registryModel("mimo-v2.6-flash-free");
	const context: Context = {
		systemPrompt: ["system"],
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
		tools: [readTool],
	};
	const controller = new AbortController();
	const options: SimpleStreamOptions = {
		sessionId: "session-x",
		textVerbosity: "low",
		maxTokens: 128,
		signal: controller.signal,
	};
	const request = buildZenRequest(model, context, options);

	assert.equal(request.model.api, "openai-completions");
	assert.equal(request.model.provider, PROVIDER_ID);
	assert.equal(request.model.baseUrl, BASE_URL);
	assert.equal(request.apiKey, ANONYMOUS_API_KEY);
	assert.match(request.opencodeSession, SESSION_ID_PATTERN);
	const headers = request.options.headers ?? {};
	assert.equal(headers["x-opencode-session"], request.opencodeSession);
	assert.equal(headers.Authorization, `Bearer ${ANONYMOUS_API_KEY}`);
	assert.equal(headers["User-Agent"], OPENCODE_USER_AGENT);
	assert.equal(headers["x-opencode-client"], OPENCODE_CLIENT);
	assert.deepEqual(
		Object.keys(headers).sort(),
		["Authorization", "User-Agent", "x-opencode-client", "x-opencode-session"],
		"only the verified fingerprint headers are sent",
	);
	assert.equal(request.context, context, "context passes through when read is declared");
	assert.equal(request.options.textVerbosity, "low");
	assert.equal(request.options.maxTokens, 128);
	assert.equal(request.options.signal, controller.signal);
	assert.equal(request.options.sessionId, "session-x");
	assert.equal(typeof request.options.fetch, "function");
	assert.equal(request.sessionId, "session-x");
});

test("Responses-lane delegation supplies the compat omp's handler requires", () => {
	__clearSessionHeaderCacheForTests();
	const model = registryModel("muse-spark-1.3-contributor-free");
	const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [readTool] };
	const request = buildZenRequest(model, context, { sessionId: "session-compat" });

	assert.equal(request.model.api, "openai-responses");
	const compat = request.model.compat as Record<string, unknown> | undefined;
	assert.ok(compat, "the Responses handler dereferences model.compat at entry");
	assert.equal(compat.supportsImageDetailOriginal, false);
	assert.equal(compat.connectionBoundNativeHistory, false, "the flag omp dereferences unguarded must exist");
	assert.deepEqual(compat, catalogueModel("muse-spark-1.3-contributor-free").compat);
});

test("an unknown Responses-lane id still gets catalogue-shaped compat", () => {
	__clearSessionHeaderCacheForTests();
	const model = { ...registryModel("muse-spark-1.3-contributor-free"), id: "muse-spark-9.9-contributor-free" };
	const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [readTool] };
	const request = buildZenRequest(model, context, { sessionId: "session-future" });

	assert.equal(request.model.api, "openai-responses");
	const compat = request.model.compat as Record<string, unknown> | undefined;
	assert.ok(compat, "a synthetic Responses model must not leave compat undefined");
	assert.equal(compat.supportsImageDetailOriginal, false);
});

test("Chat Completions models keep the compat omp resolved for them", () => {
	__clearSessionHeaderCacheForTests();
	const model = registryModel("mimo-v2.6-flash-free");
	const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [readTool] };

	const untouched = buildZenRequest(model, context, { sessionId: "session-untouched" });
	assert.equal(untouched.model.compat, undefined, "the completions handler resolves its own compat");

	const supplied = { supportsSamplingParams: false };
	const withHostCompat = buildZenRequest({ ...model, compat: supplied } as Model<Api>, context, {
		sessionId: "session-host-compat",
	});
	assert.equal(withHostCompat.model.compat, supplied, "host-resolved compat wins over the catalogue value");
});

test("the same omp session reuses one Zen session id between turns", () => {
	__clearSessionHeaderCacheForTests();
	const model = registryModel("mimo-v2.6-flash-free");
	const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [readTool] };
	const first = buildZenRequest(model, context, { sessionId: "stable" });
	const second = buildZenRequest(model, context, { sessionId: "stable" });
	const other = buildZenRequest(model, context, { sessionId: "other" });
	assert.equal(first.opencodeSession, second.opencodeSession);
	assert.notEqual(first.opencodeSession, other.opencodeSession);
});

test("catalogue-backed wire api follows the model family", () => {
	assert.equal(wireApiFor("mimo-v2.6-flash-free"), "openai-completions");
	assert.equal(wireApiFor("muse-spark-1.3-contributor-free"), "openai-responses");
	assert.equal(wireApiFor("totally-unknown-free"), "openai-completions");
	assert.equal(wireApiFor("muse-spark-9.9-contributor-free"), "openai-responses");
});

test("registered models are free chat models on the extension api", () => {
	const entries = zenModelEntries();
	assert.ok(entries.length > 10, `expected a populated free catalogue, got ${entries.length}`);
	const ids = entries.map(entry => entry.config.id);
	assert.ok(ids.includes("muse-spark-1.3-contributor-free"));
	assert.ok(!ids.includes("minimax-m2.5-free"), "anthropic-lane free models are out of scope");
	assert.ok(!ids.includes("jev-1.13-free"), "non-chat free ids are excluded");
	for (const { config } of entries) {
		assert.equal(config.api, ZEN_API);
		assert.equal(config.kind, "chat");
		assert.deepEqual(config.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.ok((config.contextWindow ?? 0) > 0);
		assert.ok((config.maxTokens ?? 0) > 0);
	}
	assert.deepEqual(
		zenModels().map(config => config.id),
		ids,
	);
});

test("paid catalogue models never reach the provider", () => {
	const registered = new Set(zenModels().map(config => config.id));
	for (const model of getBundledModels("opencode-zen")) {
		const paid = model.cost.input !== 0 || model.cost.output !== 0;
		if (paid) assert.ok(!registered.has(model.id), `${model.id} is paid but was registered`);
	}
});

test("unknown free id synthesis is conservative and idempotent", () => {
	assert.equal(isUnknownFreeId("new-model-free"), true);
	assert.equal(isUnknownFreeId("new-model"), false);
	assert.equal(isUnknownFreeId("jev-1.13-free"), false);
	assert.equal(prettyFreeName("step-5-preview-free"), "Step 5 Preview Free");
	const synthetic = syntheticFreeModel("new-model-free");
	assert.equal(synthetic.api, ZEN_API);
	assert.equal(synthetic.reasoning, true);
	assert.deepEqual(synthetic.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("live refresh intersects known ids and adds unknown free ids", async () => {
	const realFetch = globalThis.fetch;
	const known = zenModels()[0];
	assert.ok(known);
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		assert.match(String(input), /\/models$/);
		return new Response(
			JSON.stringify({ data: [{ id: known.id }, { id: "brand-new-free" }, { id: "paid-model" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	try {
		const models = await fetchFreeModels(undefined);
		const ids = models.map(model => model.id);
		assert.deepEqual(ids, [known.id, "brand-new-free"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("live refresh surfaces a transport failure instead of emptying the roster", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
	try {
		await assert.rejects(fetchFreeModels(undefined), /HTTP 503/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("encrypted content rotation is detected and stripped", () => {
	assert.equal(isEncryptedContentError(400, 'reasoning `encrypted_content` was not issued to this caller'), true);
	assert.equal(isEncryptedContentError(400, "encrypted content could not be verified"), true);
	assert.equal(isEncryptedContentError(401, "encrypted_content"), false);
	assert.equal(isEncryptedContentError(400, "unrelated"), false);

	const stripped = stripStaleReasoning({
		input: [
			{ type: "reasoning", id: "rs_1", encrypted_content: "x" },
			{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
		],
	}) as { input: Record<string, unknown>[] };
	assert.deepEqual(stripped.input, [{ type: "function_call", call_id: "call_1", name: "read" }]);
	assert.equal(stripStaleReasoning({ input: [{ type: "message" }] }), null);
	assert.equal(stripStaleReasoning({}), null);
});

test("Zen rotation retries once with reasoning stripped", async () => {
	const seen: string[] = [];
	const inner = (async (_url: unknown, init?: unknown) => {
		const body = typeof init === "object" && init !== null && "body" in init ? String(init.body) : "";
		seen.push(body);
		if (seen.length === 1) {
			return new Response('reasoning `encrypted_content` was not issued to this caller', { status: 400 });
		}
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	const wrapped = withEncryptedContentFallback(inner);
	const body = JSON.stringify({ input: [{ type: "reasoning", id: "rs_1" }, { type: "message", role: "user" }] });
	const response = await (wrapped as unknown as (url: string, init: unknown) => Promise<Response>)("https://example.test", { method: "POST", body });
	assert.equal(response.status, 200);
	assert.equal(seen.length, 2);
	assert.deepEqual(JSON.parse(seen[1]).input, [{ type: "message", role: "user" }]);

	const once = async (_url: unknown) => new Response("boom", { status: 500 });
	const passthrough = withEncryptedContentFallback(once as unknown as typeof fetch);
	const failed = await (passthrough as unknown as (url: string) => Promise<Response>)("https://example.test");
	assert.equal(failed.status, 500);
});

test("delegated stream sends the fingerprint and returns tool calls unrenamed", async () => {
	__clearSessionHeaderCacheForTests();
	const captured: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
	const fakeFetch = (async (input: unknown, init?: unknown) => {
		captured.url = String(input);
		const headers: Record<string, string> = {};
		if (typeof init === "object" && init !== null && "headers" in init) {
			for (const [name, value] of Object.entries(init.headers as Record<string, string>)) headers[name] = String(value);
		}
		captured.headers = headers;
		if (typeof init === "object" && init !== null && "body" in init) captured.body = JSON.parse(String(init.body));
		return sseResponse([
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] }),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"/etc"}' } }] }),
			`data: ${JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion.chunk",
				created: 0,
				model: "mimo-v2.6-flash-free",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
			"data: [DONE]\n\n",
		]);
	}) as unknown as typeof fetch;

	const model = registryModel("mimo-v2.6-flash-free");
	const context: Context = {
		systemPrompt: ["system prompt"],
		messages: [{ role: "user", content: "list /etc", timestamp: 0 }],
		tools: [readTool, { name: "bash", description: "omp bash", parameters: {} }],
	};
	const stream = zenStreamSimple(model, context, { sessionId: "stream-session", fetch: fakeFetch });
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	const message = await stream.result();

	assert.equal(captured.url, `${BASE_URL}/chat/completions`);
	const headers = captured.headers ?? {};
	assert.match(headers["x-opencode-session"] ?? "", SESSION_ID_PATTERN);
	assert.equal(headers.Authorization, "Bearer public");
	const body = captured.body ?? {};
	assert.equal(body.stream, true);
	assert.equal(body.model, "mimo-v2.6-flash-free");
	const toolNames = (body.tools as { function: { name: string } }[]).map(tool => tool.function.name);
	assert.deepEqual(toolNames, ["read", "bash"], "caller tools travel unrenamed");
	const call = message.content.find(block => block.type === "toolCall");
	assert.ok(call && call.type === "toolCall");
	assert.equal(call.name, "read");
	assert.deepEqual(call.arguments, { path: "/etc" });
	assert.equal(message.stopReason, "toolUse");
	assert.ok(events.includes("toolcall_end"));
});
