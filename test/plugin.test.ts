/**
 * Unit tests for the plugin entry (`src/index.ts`) — the surface omp's
 * extension loader sees when it runs `opencodeFreeExtension(pi)`.
 *
 * Every assertion here is about what omp receives: the registration contract,
 * the free-tier identity in the config, the roster it exposes, and the
 * `/login` flow the entry itself implements.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OAuthLoginCallbacks, OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import opencodeFreeExtension from "../src/index.ts";
import {
	PROVIDER_ID,
	ZEN_API,
	fetchFreeModels,
	wireApiFor,
	zenStreamSimple,
} from "../src/provider.ts";

type RegisteredConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

interface Capture {
	readonly labels: string[];
	readonly registrations: ReadonlyArray<{ name: string; config: RegisteredConfig }>;
}

/** models.dev payload: one bundled free id, one new free id, one paid, one retired. */
const LIVE_PAYLOAD = {
	opencode: {
		models: {
			"longcat-2.5-preview-free": { name: "LongCat 2.5 Preview Free", cost: { input: 0, output: 0 } },
			"brand-new-free": {
				name: "Brand New Free",
				cost: { input: 0, output: 0 },
				limit: { context: 4096, output: 512 },
			},
			"paid-model": { name: "Paid Model", cost: { input: 1, output: 2 } },
			"retired-free": { name: "Retired Free", cost: { input: 0, output: 0 }, status: "deprecated" },
		},
	},
};

/**
 * Run the extension against a recording stand-in for omp's ExtensionAPI. The
 * entry fetches models.dev before it registers, so every run stubs fetch: the
 * default is an unreachable catalogue, which must fall back to the bundle.
 */
async function registerPlugin(options: { roster?: "live" | "offline" } = {}): Promise<Capture> {
	const labels: string[] = [];
	const registrations: Array<{ name: string; config: RegisteredConfig }> = [];
	const pi = {
		setLabel(entryIdOrLabel: string, label?: string): void {
			labels.push(label === undefined ? entryIdOrLabel : `${entryIdOrLabel}\u0000${label}`);
		},
		registerProvider(name: string, config: RegisteredConfig): void {
			registrations.push({ name, config });
		},
	} satisfies Pick<ExtensionAPI, "setLabel" | "registerProvider">;
	const realFetch = globalThis.fetch;
	globalThis.fetch =
		options.roster === "live"
			? (async () =>
					new Response(JSON.stringify(LIVE_PAYLOAD), {
						status: 200,
						headers: { "content-type": "application/json" },
					})) as typeof fetch
			: (async () => {
					throw new Error("catalogue unreachable");
				}) as typeof fetch;
	try {
		await opencodeFreeExtension(pi as ExtensionAPI);
	} finally {
		globalThis.fetch = realFetch;
	}
	return { labels, registrations };
}

async function onlyConfig(): Promise<RegisteredConfig> {
	const { registrations } = await registerPlugin();
	assert.equal(registrations.length, 1, "the entry must register exactly one provider");
	const config = registrations[0]?.config;
	assert.ok(config);
	return config;
}

async function onlyLogin(): Promise<NonNullable<RegisteredConfig["oauth"]>> {
	const oauth = (await onlyConfig()).oauth;
	assert.ok(oauth, "the entry must register /login support");
	return oauth;
}

function callbacksReturning(answer: string, prompts?: OAuthPrompt[]): OAuthLoginCallbacks {
	return {
		onAuth() {},
		onPrompt: async prompt => {
			prompts?.push(prompt);
			return answer;
		},
	};
}

test("entry registers one provider under the free id with the display label", async () => {
	const { labels, registrations } = await registerPlugin();
	assert.equal(registrations.length, 1);
	assert.equal(PROVIDER_ID, "opencode-zen-free", "provider id is the documented contract");
	assert.equal(registrations[0]?.name, PROVIDER_ID);
	assert.deepEqual(labels, ["OpenCode Zen Free"], "label is what /model shows");
});

test("registered config carries the free-tier identity", async () => {
	const config = await onlyConfig();
	assert.equal(config.baseUrl, "https://opencode.ai/zen/v1");
	assert.equal(config.apiKey, "public", "anonymous bearer is the fallback only");
	assert.equal(config.authHeader, false, "provider writes Authorization itself; the host must not inject a second one");
	assert.equal(config.api, ZEN_API, "dispatch resolves models through the extension-owned api id");
});

test("entry wires the provider's own streaming and discovery functions", async () => {
	const config = await onlyConfig();
	// Registration is the entry's only job beyond config; pointing either at the
	// wrong function breaks every turn, and nothing downstream re-checks it.
	assert.equal(config.streamSimple, zenStreamSimple);
	assert.equal(config.fetchDynamicModels, fetchFreeModels);
});

test("registered roster is the live free set, not a catalogue of retired ids", async () => {
	const { registrations } = await registerPlugin({ roster: "live" });
	const models = registrations[0]?.config.models ?? [];
	assert.deepEqual(
		models.map(model => model.id),
		["brand-new-free", "longcat-2.5-preview-free"],
		"paid and retired models.dev entries never reach the host",
	);
});

test("registered roster falls back to the bundled catalogue when models.dev is unreachable", async () => {
	const config = await onlyConfig();
	const models = config.models ?? [];
	assert.ok(models.length > 10, `expected a populated fallback roster, got ${models.length}`);
	const ids = new Set(models.map(model => model.id));
	assert.ok(ids.has("mimo-v2.6-flash-free"), "known free chat model missing");
	// The static fallback is the bundled catalogue, which carries no `status`
	// field, so a refresh retires this id and a cold start still lists it.
	assert.ok(ids.has("muse-spark-1.3-contributor-free"), "known free responses model missing");
	for (const model of getBundledModels("opencode-zen")) {
		const paid = model.cost.input !== 0;
		if (paid) assert.ok(!ids.has(model.id), `paid model ${model.id} leaked into the registered roster`);
	}
	assert.ok(
		models.some(model => wireApiFor(model.id) === "openai-completions"),
		"chat-lane model missing",
	);
	assert.ok(
		models.some(model => wireApiFor(model.id) === "openai-responses"),
		"responses-lane model missing",
	);
});

test("login prompt is secret and names the env-var fallback", async () => {
	const oauth = await onlyLogin();
	assert.equal(oauth.name, "OpenCode Zen");
	const prompts: OAuthPrompt[] = [];
	await oauth.login(callbacksReturning("oc_sk_probe", prompts));
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0]?.secret, true, "key entry must not echo");
	assert.match(prompts[0]?.message ?? "", /anonymous/i, "prompt must explain the keyless path");
	assert.ok(
		(prompts[0]?.message ?? "").includes("OPENCODE_API_KEY"),
		"prompt must name the env var fallback",
	);
});

test("empty login input is refused with the anonymous-tier hint", async () => {
	const oauth = await onlyLogin();
	await assert.rejects(
		() => oauth.login(callbacksReturning("   ")),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /anonymous/i);
			return true;
		},
	);
});

test("entered login key is trimmed before it is persisted", async () => {
	const key = await (await onlyLogin()).login(callbacksReturning("  oc_sk_test  "));
	assert.equal(key, "oc_sk_test");
});
