/**
 * Opt-in live check: sends small requests to the real free tier through the
 * provider's own code path. Never run by `npm test`.
 *
 *   bun run test/live.ts                       # both lanes
 *   OPENCODE_FREE_MODEL=mimo-v2.6-flash-free bun run test/live.ts
 *   OPENCODE_API_KEY=sk-... bun run test/live.ts
 *
 * Uses the anonymous tier unless OPENCODE_API_KEY is set.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

import { BASE_URL, PROVIDER_ID, ZEN_API, zenStreamSimple } from "../src/provider.ts";

/** One model per wire lane: Chat Completions and Responses. */
const DEFAULT_MODELS = ["longcat-2.5-preview-free", "muse-spark-1.3-contributor-free"];
const modelIds = process.env.OPENCODE_FREE_MODEL ? [process.env.OPENCODE_FREE_MODEL] : DEFAULT_MODELS;

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
	return Buffer.concat([size, typeBytes, data, crc]);
}

function squarePng(): Buffer {
	const raw = Buffer.alloc(64 * (1 + 64 * 3));
	for (let y = 0; y < 64; y++) {
		for (let x = 0; x < 64; x++) {
			const rgb = x >= 16 && x < 48 && y >= 16 && y < 48 ? [250, 230, 20] : [30, 50, 200];
			raw.set(rgb, y * 193 + 1 + x * 3);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(64);
	ihdr.writeUInt32BE(64, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const png = squarePng();

function visionContext(): Context {
	return {
		systemPrompt: [
			"Use record_colors to record the colors visible in the image. After its result, reply with the receipt code only.",
		],
		messages: [
			{
				role: "user",
				timestamp: Date.now(),
				content: [
					{ type: "text", text: "Record the background and center-square colors in this image." },
					{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
				],
			},
		],
		tools: [
			{
				name: "read",
				description: "Read the contents of a file or directory.",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
			{
				name: "record_colors",
				description: "Record observed image colors and receive a receipt code.",
				parameters: {
					type: "object",
					properties: { background: { type: "string" }, square: { type: "string" } },
					required: ["background", "square"],
				},
			},
		],
	};
}

for (const modelId of modelIds) {
	const catalogue = getBundledModels("opencode-zen").find(model => model.id === modelId);
	assert.ok(catalogue, `${modelId} is not in the bundled opencode-zen catalogue`);
	const model: Model<Api> = { ...catalogue, provider: PROVIDER_ID, api: ZEN_API, baseUrl: BASE_URL };
	const context = visionContext();
	const options = { sessionId: randomUUID(), maxTokens: 4096 };

	const events = new Set<string>();
	const stream = zenStreamSimple(model, context, options);
	for await (const event of stream) events.add(event.type);
	const first = await stream.result();
	assert.equal(first.stopReason, "toolUse", first.errorMessage ?? JSON.stringify(first.content));
	const call = first.content.find(block => block.type === "toolCall");
	assert.ok(call && call.type === "toolCall");
	assert.equal(call.name, "record_colors");
	assert.match(String(call.arguments.background), /blue|0000ff/i);
	assert.match(String(call.arguments.square), /yellow|ffff00/i);
	console.log(
		JSON.stringify({
			check: "vision + streamed tool call over the free tier",
			passed: true,
			model: modelId,
			api: model.api,
			events: [...events],
			arguments: call.arguments,
		}),
	);

	context.messages.push(first, {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		timestamp: Date.now(),
		isError: false,
		content: [{ type: "text", text: "Receipt code: ZEN_7429" }],
	});
	const replay = zenStreamSimple(model, context, options);
	for await (const _event of replay) {
		// drain
	}
	const second = await replay.result();
	assert.equal(second.stopReason, "stop", second.errorMessage);
	const text = second.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	assert.match(text, /ZEN_7429/);
	console.log(JSON.stringify({ check: "tool result replay keeps the call id", passed: true, model: modelId, text }));
}

// Tool-less calls (compaction, titles, judgment) only pass the gate because the
// provider injects its inert `read` placeholder. Prove it end to end.
{
	const modelId = modelIds[0];
	const catalogue = getBundledModels("opencode-zen").find(model => model.id === modelId);
	assert.ok(catalogue);
	const model: Model<Api> = { ...catalogue, provider: PROVIDER_ID, api: ZEN_API, baseUrl: BASE_URL };
	const summarisation: Context = {
		systemPrompt: [
			"Summarize user-AI coding-assistant conversations in the exact specified structured format. Output ONLY the structured summary.",
		],
		messages: [
			{
				role: "user",
				timestamp: Date.now(),
				content: "Summarize: the user asked for the files in /etc, and the assistant listed them.",
			},
		],
	};
	const stream = zenStreamSimple(model, summarisation, { sessionId: randomUUID(), maxTokens: 512 });
	for await (const _event of stream) {
		// drain
	}
	const result = await stream.result();
	assert.notEqual(result.stopReason, "error", result.errorMessage);
	const text = result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	assert.ok(text.trim().length > 0, "a tool-less summarization request must still answer");
	console.log(JSON.stringify({ check: "tool-less request passes the gate", passed: true, model: modelId, text: text.slice(0, 120) }));
}
