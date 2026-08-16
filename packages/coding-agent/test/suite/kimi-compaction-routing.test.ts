import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionWithKimiCompactionInternals = {
	_pickKimiCompactionModel: () => Model<any> | undefined;
	_pickDeepseekCompactionModel: () => Model<any> | undefined;
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

function registerDeepseek(harness: Harness): void {
	harness.session.modelRegistry.registerProvider("deepseek", {
		baseUrl: "https://api.deepseek.com",
		apiKey: "deepseek-faux-key",
		api: "openai-completions",
		models: [
			{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				api: "openai-completions",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 384000,
			},
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				api: "openai-completions",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 384000,
			},
		] as any,
	});
}

function registerAnthropic(harness: Harness): void {
	harness.session.modelRegistry.registerProvider("anthropic", {
		baseUrl: "https://api.anthropic.com",
		apiKey: "anthropic-faux-key",
		api: "anthropic-messages",
		models: [
			{
				id: "claude-sonnet",
				name: "Claude Sonnet",
				api: "anthropic-messages",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		] as any,
	});
}

describe("AgentSession compaction routing", () => {
	it("stays on the active model when it is neither deepseek nor anthropic (no Kimi redirect)", async () => {
		const harness = await createHarness();
		registerKimiCoding(harness);
		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;

		// A non-Claude, non-DeepSeek active model summarizes through itself;
		// Kimi is available but must not be selected.
		const fallbackModel = harness.getModel();
		const auth = await internals._resolveCompactionAuth(fallbackModel);
		expect(auth.model.provider).toBe(fallbackModel.provider);
		expect(auth.model.id).toBe(fallbackModel.id);
	});

	it("routes Claude (anthropic) through kimi k3-256k when authenticated and context fits", async () => {
		const harness = await createHarness();
		registerKimiCoding(harness);
		registerAnthropic(harness);
		setContextTokens(harness, 1000); // well under k3-256k's usable budget

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const picked = internals._pickKimiCompactionModel();
		expect(picked?.provider).toBe("kimi-coding");
		expect(picked?.id).toBe("k3-256k");

		const anthropicModel = harness.session.modelRegistry.find("anthropic", "claude-sonnet")!;
		const auth = await internals._resolveCompactionAuth(anthropicModel);
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

	it("routes deepseek through deepseek-v4-pro (never Kimi)", async () => {
		const harness = await createHarness();
		registerDeepseek(harness);
		registerKimiCoding(harness);

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const picked = internals._pickDeepseekCompactionModel();
		expect(picked?.provider).toBe("deepseek");
		expect(picked?.id).toBe("deepseek-v4-pro");

		const deepseekModel = harness.session.modelRegistry.find("deepseek", "deepseek-v4-flash")!;
		const auth = await internals._resolveCompactionAuth(deepseekModel);
		expect(auth.model.provider).toBe("deepseek");
		expect(auth.model.id).toBe("deepseek-v4-pro");
		expect(auth.apiKey).toBe("deepseek-faux-key");
	});

	it("stays on Kimi when the active model is already kimi-coding (no redundant redirect)", async () => {
		const harness = await createHarness();
		registerKimiCoding(harness);
		setContextTokens(harness, 1000);

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const kimiK3 = harness.session.modelRegistry.find("kimi-coding", "k3")!;
		const auth = await internals._resolveCompactionAuth(kimiK3);
		// Active model is already kimi-coding — the resolver must not redirect
		// away from it.
		expect(auth.model.provider).toBe("kimi-coding");
		expect(auth.model.id).toBe("k3");
	});
	it("honors a custom compaction.fallbackModels list (skips unlisted models)", async () => {
		const harness = await createHarness({
			settings: { compaction: { fallbackModels: "kimi-coding/k3" } },
		});
		registerKimiCoding(harness);
		// 50k tokens fits k3-256k's usable budget, but k3-256k is unlisted.
		setContextTokens(harness, 50_000);

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		expect(internals._pickKimiCompactionModel()?.id).toBe("k3");
	});

	it("routes Claude through a non-Kimi fallback when configured", async () => {
		const harness = await createHarness({
			settings: { compaction: { fallbackModels: "deepseek/deepseek-v4-flash" } },
		});
		registerKimiCoding(harness);
		registerDeepseek(harness);
		registerAnthropic(harness);
		setContextTokens(harness, 1000);

		const internals = harness.session as unknown as SessionWithKimiCompactionInternals;
		const anthropicModel = harness.session.modelRegistry.find("anthropic", "claude-sonnet")!;
		const auth = await internals._resolveCompactionAuth(anthropicModel);
		expect(auth.model.provider).toBe("deepseek");
		expect(auth.model.id).toBe("deepseek-v4-flash");
	});
});
