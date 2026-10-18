/**
 * Byte-level fixture tests: the client must reproduce capture Http 312
 * (responses lane, fully captured: 14 header lines + 3895-byte body) and the
 * Http 323 chat prefix. Fixtures were extracted from `opencode.xml` with the
 * debugger's bearer redaction left in place.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildChatBody, buildOpencodeRequest, buildResponsesBody, rawRequestBlock } from "../src/opencode-client.ts";

const headersFixture = readFileSync(new URL("./fixtures/capture-312.headers.txt", import.meta.url), "utf8")
	.trimEnd()
	.split("\n");
const bodyFixture = readFileSync(new URL("./fixtures/capture-312.body.json", import.meta.url));
const chatPrefixFixture = readFileSync(new URL("./fixtures/capture-323.chat-prefix.txt", import.meta.url), "utf8");

const CAPTURE_SESSION = "ses_eb27f8a80ffeRXsK4FsLEg1Zx9";
const CAPTURE_USER = "msg_14d8075ca001W5wUFTMEsrvz3H";

function normalizeAuthorization(block: string): string {
	return block
		.split("\r\n")
		.map(line => (line.startsWith("Authorization:") ? "Authorization: <redacted>" : line))
		.join("\r\n");
}

test("responses body is byte-identical to the capture", () => {
	const parsed = JSON.parse(bodyFixture.toString("utf8"));
	const body = buildResponsesBody({
		model: parsed.model,
		input: parsed.input,
		maxOutputTokens: parsed.max_output_tokens,
		include: parsed.include,
		reasoning: parsed.reasoning,
		store: parsed.store,
	});
	const built = Buffer.from(JSON.stringify(body), "utf8");
	assert.equal(built.length, 3895, "byte length must match Content-Length in the capture");
	assert.ok(built.equals(bodyFixture), "serialized body must equal the captured bytes");
});

test("request header block matches the capture line for line", () => {
	const parsed = JSON.parse(bodyFixture.toString("utf8"));
	const request = buildOpencodeRequest({
		lane: "responses",
		sessionId: CAPTURE_SESSION,
		userId: CAPTURE_USER,
		providerId: "opencode",
		apiKey: "REDACTED_FIXTURE_KEY",
		body: buildResponsesBody({
			model: parsed.model,
			input: parsed.input,
			maxOutputTokens: parsed.max_output_tokens,
			include: parsed.include,
			reasoning: parsed.reasoning,
			store: parsed.store,
		}),
	});
	const captured = headersFixture.join("\r\n");
	const headerSection = rawRequestBlock(request).split("\r\n\r\n")[0];
	assert.equal(normalizeAuthorization(headerSection), normalizeAuthorization(captured), "wire headers must match the capture");
});

test("chat body head matches the captured prefix", () => {
	const head = '{"model":"space-bunny-free","max_tokens":32000,"messages":[{"role":"system","content":"';
	assert.ok(chatPrefixFixture.startsWith(head), "capture must carry the chat head");
	const body = JSON.stringify(
		buildChatBody({
			model: "space-bunny-free",
			maxOutputTokens: 32000,
			messages: [{ role: "system", content: "You are opencode, an interactive CLI tool." }],
		}),
	);
	assert.ok(body.startsWith(head), "built chat body must share the captured head");
});

test("chat tools are sorted by function name", () => {
	const body = buildChatBody({
		model: "m",
		messages: [],
		tools: [
			{ type: "function", function: { name: "write" } },
			{ type: "function", function: { name: "bash" } },
			{ type: "function", function: { name: "read" } },
		],
	});
	const tools = body.tools;
	assert.ok(Array.isArray(tools));
	const names: string[] = [];
	for (const tool of tools) {
		assert.ok(tool && typeof tool === "object" && "function" in tool);
		const fn = tool.function;
		assert.ok(fn && typeof fn === "object" && "name" in fn && typeof fn.name === "string");
		names.push(fn.name);
	}
	assert.deepEqual(names, ["bash", "read", "write"]);
});
