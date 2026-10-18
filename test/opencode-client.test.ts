/**
 * Offline fixture test: the standalone client must reproduce the header craft
 * in the `opencode.xml` capture (opencode 1.19.0, Http 312/323).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ANONYMOUS_API_KEY,
	buildOpencodeHeaders,
	buildOpencodeRequest,
	createMessageId,
	createSessionId,
	opencodeUrl,
	resolveApiKey,
	withSdkUserAgent,
} from "../src/opencode-client.ts";

/** Ids straight from the capture (Http 312 request header). */
const CAPTURE_SESSION = "ses_eb27f8a80ffeRXsK4FsLEg1Zx9";
const CAPTURE_USER = "msg_14d8075ca001W5wUFTMEsrvz3H";

test("opencode branch reproduces the captured header set", () => {
	const headers = buildOpencodeHeaders({
		sessionId: CAPTURE_SESSION,
		userId: CAPTURE_USER,
		providerId: "opencode",
	});
	assert.equal(headers["x-opencode-session-id"], CAPTURE_SESSION);
	assert.equal(headers["x-opencode-project"], "global");
	assert.equal(headers["x-opencode-session"], CAPTURE_SESSION);
	assert.equal(headers["x-opencode-request"], CAPTURE_USER);
	assert.equal(headers["x-opencode-client"], "cli");
	assert.equal(headers["User-Agent"], "opencode/1.19.0");
	assert.ok(!("x-session-affinity" in headers));
});

test("responses lane UA matches the capture exactly", () => {
	const headers = withSdkUserAgent(
		buildOpencodeHeaders({ sessionId: CAPTURE_SESSION, userId: CAPTURE_USER, providerId: "opencode" }),
		"4.0.40",
		"bun/1.3.14",
	);
	assert.equal(headers["User-Agent"], "opencode/1.19.0 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14");
});

test("chat lane UA matches the capture exactly", () => {
	const headers = withSdkUserAgent(
		buildOpencodeHeaders({ sessionId: CAPTURE_SESSION, userId: CAPTURE_USER, providerId: "opencode" }),
		"4.0.23",
		"bun/1.3.14",
	);
	assert.equal(headers["User-Agent"], "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14");
});

test("non-opencode providers take the affinity branch", () => {
	const headers = buildOpencodeHeaders({
		sessionId: CAPTURE_SESSION,
		userId: CAPTURE_USER,
		providerId: "anthropic",
	});
	assert.equal(headers["x-session-affinity"], CAPTURE_SESSION);
	assert.equal(headers["X-Session-Id"], CAPTURE_SESSION);
	assert.ok(!("x-opencode-session" in headers));
	assert.ok(!("x-opencode-request" in headers));
});

test("request builder targets the captured endpoints with a bearer", () => {
	const responses = buildOpencodeRequest({
		lane: "responses",
		sessionId: CAPTURE_SESSION,
		userId: CAPTURE_USER,
		providerId: "opencode",
		body: { model: "gpt-5.4-nano" },
		apiKey: "KEY123",
	});
	assert.equal(responses.url, "https://opencode.ai/inference/openai/v1/responses");
	assert.equal(responses.headers["Authorization"], "Bearer KEY123");
	assert.equal(responses.headers["Content-Type"], "application/json");
	assert.equal(opencodeUrl("chat"), "https://opencode.ai/inference/openai/v1/chat/completions");
});

test("minted ids match the capture shape", () => {
	assert.match(createSessionId(), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	assert.match(createMessageId(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("credential precedence: explicit, then env, then anonymous", () => {
	assert.equal(resolveApiKey("KEY123"), "KEY123");
	const saved = process.env.OPENCODE_API_KEY;
	try {
		delete process.env.OPENCODE_API_KEY;
		assert.equal(resolveApiKey(), ANONYMOUS_API_KEY);
		process.env.OPENCODE_API_KEY = "ENVKEY";
		assert.equal(resolveApiKey(), "ENVKEY");
	} finally {
		if (saved === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = saved;
	}
});
