import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.js";
import {
	getKimiCommonHeaders,
	kimiCodingOAuthProvider,
	loginKimi,
	refreshKimiToken,
} from "../src/utils/oauth/kimi-coding.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("Kimi For Coding OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("requests device authorization, polls through authorization_pending, and returns parsed credentials", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollBodies: string[] = [];
		const tokenResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({
				access_token: "kimi-access-token",
				refresh_token: "kimi-refresh-token",
				expires_in: 3600,
			}),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			expect(init?.headers).toMatchObject({ "X-Msh-Platform": "kimi_cli" });

			if (url.endsWith("/api/oauth/device_authorization")) {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("client_id")).toBe("17e5f671-d194-4dfb-9706-5516cb48c098");
				return jsonResponse({
					user_code: "ABCD-1234",
					device_code: "device-code",
					verification_uri: "https://auth.kimi.com/device",
					verification_uri_complete: "https://auth.kimi.com/device?code=ABCD-1234",
					expires_in: 900,
					interval: 5,
				});
			}

			if (url.endsWith("/api/oauth/token")) {
				pollBodies.push(String(init?.body));
				const response = tokenResponses.shift();
				if (!response) throw new Error("Unexpected extra token poll");
				return response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		const loginPromise = loginKimi({
			onAuth: (info) => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async () => "",
		});

		// First poll fires immediately, gets authorization_pending, waits ~5s, polls again.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5000);
		const credentials = await loginPromise;

		expect(authUrl).toBe("https://auth.kimi.com/device?code=ABCD-1234");
		expect(authInstructions).toBe("Enter code: ABCD-1234");
		expect(pollBodies).toHaveLength(2);
		for (const body of pollBodies) {
			const params = new URLSearchParams(body);
			expect(params.get("device_code")).toBe("device-code");
			expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		}

		expect(credentials.access).toBe("kimi-access-token");
		expect(credentials.refresh).toBe("kimi-refresh-token");
		// expires is now + expires_in - skew, so it should be in the future.
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("refreshes tokens via the refresh_token grant, falling back to the prior refresh token if omitted", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			expect(url).toBe("https://auth.kimi.com/api/oauth/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("old-refresh-token");
			return jsonResponse({ access_token: "new-access-token", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshKimiToken("old-refresh-token");
		expect(credentials.access).toBe("new-access-token");
		// No refresh_token in the response — falls back to the token that was sent.
		expect(credentials.refresh).toBe("old-refresh-token");
	});

	it("throws when the refresh response is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "expired" }, 401)),
		);
		await expect(refreshKimiToken("bad-token")).rejects.toThrow(/Kimi token refresh failed: 401/);
	});

	it("exposes stable common headers across calls", () => {
		const first = getKimiCommonHeaders();
		const second = getKimiCommonHeaders();
		expect(first).toBe(second);
		expect(first["User-Agent"]).toMatch(/^KimiCLI\//);
		expect(first["X-Msh-Device-Id"]).toBeTruthy();
	});

	it("provider surface: id/getApiKey/modifyModels wire OAuth access tokens into kimi-coding models", () => {
		expect(kimiCodingOAuthProvider.id).toBe("kimi-coding");
		expect(kimiCodingOAuthProvider.getApiKey({ access: "a", refresh: "r", expires: 0 })).toBe("a");

		const models: Model<Api>[] = [
			{
				id: "k3-256k",
				name: "Kimi K3-256K",
				api: "anthropic-messages",
				provider: "kimi-coding",
				baseUrl: "https://api.kimi.com/coding",
				headers: { "User-Agent": "KimiCLI/1.5" },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 131072,
			} as unknown as Model<Api>,
			{
				id: "gpt-5-mini",
				name: "GPT 5 Mini",
				api: "anthropic-messages",
				provider: "github-copilot",
				baseUrl: "https://api.individual.githubcopilot.com",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			} as unknown as Model<Api>,
		];

		const modified = kimiCodingOAuthProvider.modifyModels!(models, { access: "a", refresh: "r", expires: 0 });
		const kimiModel = modified.find((m) => m.provider === "kimi-coding")!;
		const otherModel = modified.find((m) => m.provider === "github-copilot")!;

		expect(kimiModel.headers).toMatchObject({ "User-Agent": "KimiCLI/1.5.0", "X-Msh-Platform": "kimi_cli" });
		expect(otherModel.headers).toBeUndefined();
	});
});
