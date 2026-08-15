import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionWithKimiCompactionInternals = {
	_pickKimiCompactionModel: () => Model<any> | undefined;
	_resolveCompactionAuth: (fallbackModel: Model<any>) => Promise<{
		model: Model<any>;
		apiKey: string;
		headers?: Record<string, string>;
	}>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function setContextTokens(harness: Harness, totalTokens: number): void {
	const model = harness.getModel();
	harness.session.agent.state.messages = [
		{
			...fauxAssistantMessage("prior turn"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(totalTokens),
		},
	];
}

function registerKimiCoding(harness: Harness): void {
	harness.session.modelRegistry.registerProvider("kimi-coding", {
		baseUrl: "https://api.kimi.com/coding",
		apiKey: "kimi-faux-key",
		api: "anthropic-messages",
		models: [
			{
				id: "k3-256k",
				name: "Kimi K3-256K",
				api: "anthropic-messages",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 131072,
			},
			{
				id: "k3",
				name: "Kimi K3",
				api: "anthropic-messages",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
			},
		] as any,
	});
}

describe("AgentSession Kimi-first compaction routing", () => {
	it("falls back to the active model when Kimi For Coding isn't authenticated", async () => {
		const harness = await createHarness();
		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;

		// _pickKimiCompactionModel only chooses among catalog entries; auth
		// gating happens in _resolveCompactionAuth, asserted below.
		const fallbackModel = harness.getModel();
		const auth = await internals._resolveCompactionAuth(fallbackModel);
		expect(auth.model.provider).toBe(fallbackModel.provider);
		expect(auth.model.id).toBe(fallbackModel.id);
	});

	it("prefers Kimi k3-256k over the active chat model when authenticated and context fits", async () => {
		const harness = await createHarness();
		registerKimiCoding(harness);
		setContextTokens(harness, 1000); // well under k3-256k's usable budget

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const picked = internals._pickKimiCompactionModel();
		expect(picked?.provider).toBe("kimi-coding");
		expect(picked?.id).toBe("k3-256k");

		const fallbackModel = harness.getModel();
		const auth = await internals._resolveCompactionAuth(fallbackModel);
		expect(auth.model.provider).toBe("kimi-coding");
		expect(auth.model.id).toBe("k3-256k");
		expect(auth.apiKey).toBe("kimi-faux-key");
	});

	it("falls back to k3 (1M window) when the context overflows k3-256k's usable budget", async () => {
		const harness = await createHarness();
		registerKimiCoding(harness);
		// k3-256k usable budget is contextWindow(262144) - maxTokens(131072) = 131072.
		setContextTokens(harness, 200000);

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const picked = internals._pickKimiCompactionModel();
		expect(picked?.provider).toBe("kimi-coding");
		expect(picked?.id).toBe("k3");
	});

	it("stays on Kimi when the active model is already kimi-coding (no redundant redirect)", async () => {
		const harness = await createHarness();
		registerKimiCoding(harness);
		setContextTokens(harness, 1000);

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const kimiK3 = harness.session.modelRegistry.find("kimi-coding", "k3")!;
		const auth = await internals._resolveCompactionAuth(kimiK3);
		// Active model is already kimi-coding — the resolver must not redirect
		// away from it (it only redirects when the active provider isn't Kimi).
		expect(auth.model.provider).toBe("kimi-coding");
		expect(auth.model.id).toBe("k3");
	});
});
