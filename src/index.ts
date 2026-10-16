/**
 * omp extension: OpenCode Zen's free models as a first-class provider.
 *
 * Registers `opencode-zen-free` with a real `/login` entry, omp's bundled
 * catalogue of free Zen models, live model discovery, and an extension-owned
 * transport that carries the OpenCode fingerprint the free tier requires.
 *
 * Why a separate provider id: omp's built-in `opencode-zen` hard-overwrites
 * `x-opencode-session` with the conversation id for that provider id
 * (`applyInferenceHeaders`), and the gate only accepts a freshly minted `ses_`
 * id. A distinct id keeps omp's identity projection out of the request.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	ANONYMOUS_API_KEY,
	BASE_URL,
	PROVIDER_ID,
	ZEN_API,
	ZEN_API_KEY_ENV,
	fetchFreeModels,
	zenModels,
	zenStreamSimple,
} from "./provider.ts";

export default function opencodeFreeExtension(pi: ExtensionAPI): void {
	pi.setLabel("OpenCode Zen Free");
	pi.registerProvider(PROVIDER_ID, {
		api: ZEN_API,
		baseUrl: BASE_URL,
		// Fallback only: registering `oauth` makes a stored credential win, so
		// this literal is sent solely when no `/login` credential exists.
		apiKey: ANONYMOUS_API_KEY,
		authHeader: false,
		models: zenModels(),
		streamSimple: zenStreamSimple,
		fetchDynamicModels: fetchFreeModels,
		oauth: {
			name: "OpenCode Zen",
			async login(callbacks) {
				const entered = (
					await callbacks.onPrompt({
						message: `OpenCode Zen API key (leave empty for the anonymous free tier, or set ${ZEN_API_KEY_ENV})`,
						secret: true,
					})
				).trim();
				if (entered.length === 0) {
					throw new Error(
						"No key entered. The anonymous free tier needs no login: use the models directly.",
					);
				}
				return entered;
			},
		},
	});
}
