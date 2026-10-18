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

/** Run the extension against a recording stand-in for omp's ExtensionAPI. */
function registerPlugin(): Capture {
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
	opencodeFreeExtension(pi as ExtensionAPI);
	return { labels, registrations };
}

function onlyConfig(): RegisteredConfig {
	const { registrations } = registerPlugin();
	assert.equal(registrations.length, 1, "the entry must register exactly one provider");
	const config = registrations[0]?.config;
	assert.ok(config);
	return config;
}

function onlyLogin(): NonNullable<RegisteredConfig["oauth"]> {
	const oauth = onlyConfig().oauth;
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

test("entry registers one provider under the free id with the display label", () => {
	const { labels, registrations } = registerPlugin();
	assert.equal(registrations.length, 1);
	assert.equal(PROVIDER_ID, "opencode-zen-free", "provider id is the documented contract");
	assert.equal(registrations[0]?.name, PROVIDER_ID);
	assert.deepEqual(labels, ["OpenCode Zen Free"], "label is what /model shows");
});

test("registered config carries the free-tier identity", () => {
	const config = onlyConfig();
	assert.equal(config.baseUrl, "https://opencode.ai/zen/v1");
	assert.equal(config.apiKey, "public", "anonymous bearer is the fallback only");
	assert.equal(config.authHeader, false, "provider writes Authorization itself; the host must not inject a second one");
	assert.equal(config.api, ZEN_API, "dispatch resolves models through the extension-owned api id");
});

test("entry wires the provider's own streaming and discovery functions", () => {
	const config = onlyConfig();
	// Registration is the entry's only job beyond config; pointing either at the
	// wrong function breaks every turn, and nothing downstream re-checks it.
	assert.equal(config.streamSimple, zenStreamSimple);
	assert.equal(config.fetchDynamicModels, fetchFreeModels);
});

test("registered roster is free-only and spans both wire lanes", () => {
	const config = onlyConfig();
	const models = config.models ?? [];
	assert.ok(models.length > 10, `expected a populated free roster, got ${models.length}`);
	const ids = new Set(models.map(model => model.id));
	assert.ok(ids.has("mimo-v2.6-flash-free"), "known free chat model missing");
	assert.ok(ids.has("muse-spark-1.3-contributor-free"), "known free responses model missing");
	for (const model of getBundledModels("opencode-zen")) {
		const paid = model.cost.input !== 0 || model.cost.output !== 0;
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
	const oauth = onlyLogin();
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
	const oauth = onlyLogin();
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
	const key = await onlyLogin().login(callbacksReturning("  oc_sk_test  "));
	assert.equal(key, "oc_sk_test");
});
