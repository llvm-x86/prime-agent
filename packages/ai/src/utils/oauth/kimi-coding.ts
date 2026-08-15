/**
 * Kimi For Coding OAuth flow (device authorization grant).
 *
 * Ported from loom's `packages/ai/src/registry/oauth/kimi.ts`. Kimi's coding
 * endpoint speaks the Anthropic Messages wire format, so the resulting access
 * token is handed to the generic `anthropic-messages` transport the same way
 * a static `KIMI_API_KEY` already is for the built-in `kimi-coding` models
 * (`k3`, `k3-256k`, `kimi-for-coding*`).
 */

import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const KIMI_CLI_VERSION = "1.5.0";

interface DeviceAuthorizationResponse {
	user_code?: string;
	device_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

function resolveOAuthHost(): string {
	if (typeof process === "undefined") return DEFAULT_OAUTH_HOST;
	return process.env?.KIMI_CODE_OAUTH_HOST || process.env?.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
}

function getDeviceModel(): string {
	if (typeof process === "undefined" || !process.platform) return "unknown";
	const platform = process.platform;
	const label =
		platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
	return [label, process.arch].filter(Boolean).join(" ");
}

// Device id identifies this install to Kimi. Generated once per process and
// kept in memory only (no filesystem persistence) to keep this module safe
// for browser/Vite bundling, matching the other OAuth providers in this dir.
let cachedDeviceId: string | undefined;
function getDeviceId(): string {
	if (!cachedDeviceId) {
		cachedDeviceId = (
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random()}`
		).replace(/-/g, "");
	}
	return cachedDeviceId;
}

let cachedHeaders: Record<string, string> | undefined;

/** Headers Kimi's servers expect on every request (OAuth handshake and completions alike). */
export function getKimiCommonHeaders(): Record<string, string> {
	if (!cachedHeaders) {
		cachedHeaders = {
			"User-Agent": `KimiCLI/${KIMI_CLI_VERSION}`,
			"X-Msh-Platform": "kimi_cli",
			"X-Msh-Version": KIMI_CLI_VERSION,
			"X-Msh-Device-Name": "prime-agent",
			"X-Msh-Device-Model": getDeviceModel(),
			"X-Msh-Os-Version": typeof process !== "undefined" ? (process.version ?? "unknown") : "unknown",
			"X-Msh-Device-Id": getDeviceId(),
		};
	}
	return cachedHeaders;
}

async function requestDeviceAuthorization(): Promise<{
	userCode: string;
	deviceCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInMs: number;
	intervalMs: number;
}> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Kimi device authorization failed: ${response.status} ${text}`);
	}

	const payload = (await response.json()) as DeviceAuthorizationResponse;
	const userCode = payload.user_code;
	const deviceCode = payload.device_code;
	const verificationUri = payload.verification_uri;
	const verificationUriComplete = payload.verification_uri_complete;

	if (!userCode || !deviceCode || !verificationUri) {
		throw new Error("Kimi device authorization response missing required fields");
	}

	const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS;
	const intervalMs =
		typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

	return {
		userCode,
		deviceCode,
		verificationUri,
		verificationUriComplete: verificationUriComplete || verificationUri,
		expiresInMs,
		intervalMs,
	};
}

function parseTokenPayload(payload: TokenResponse, refreshTokenFallback?: string): OAuthCredentials {
	if (!payload.access_token || typeof payload.expires_in !== "number") {
		throw new Error("Kimi token response missing required fields");
	}

	const refresh = payload.refresh_token ?? refreshTokenFallback;
	if (!refresh) {
		throw new Error("Kimi token response missing refresh token");
	}

	return {
		access: payload.access_token,
		refresh,
		expires: Date.now() + payload.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollForToken(
	deviceCode: string,
	intervalMs: number,
	expiresInMs: number,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const deadline = Date.now() + expiresInMs;
	let waitMs = Math.max(1000, intervalMs);

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...getKimiCommonHeaders(),
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const payload = (await response.json()) as TokenResponse;
		if (response.ok && payload.access_token) {
			return parseTokenPayload(payload);
		}

		const error = payload.error;
		if (error === "authorization_pending") {
			await abortableSleep(waitMs, signal);
			continue;
		}

		if (error === "slow_down") {
			waitMs += 5000;
			const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
			if (retryAfter && retryAfter > waitMs) waitMs = retryAfter;
			await abortableSleep(waitMs, signal);
			continue;
		}

		if (error === "expired_token") {
			throw new Error("Kimi device authorization expired");
		}

		if (error === "access_denied") {
			throw new Error("Kimi device authorization denied");
		}

		const description = payload.error_description ? `: ${payload.error_description}` : "";
		throw new Error(`Kimi device flow failed: ${error ?? response.status}${description}`);
	}

	throw new Error("Kimi device flow timed out");
}

/**
 * Login with Kimi For Coding OAuth (device code flow).
 */
export async function loginKimi(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceAuthorization();
	callbacks.onAuth({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});

	return pollForToken(device.deviceCode, device.intervalMs, device.expiresInMs, callbacks.signal);
}

/**
 * Refresh Kimi For Coding OAuth token.
 */
export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
		const description = payload?.error_description ? `: ${payload.error_description}` : "";
		throw new Error(`Kimi token refresh failed: ${response.status}${description}`);
	}

	const payload = (await response.json()) as TokenResponse;
	return parseTokenPayload(payload, refreshToken);
}

export const kimiCodingOAuthProvider: OAuthProviderInterface = {
	id: "kimi-coding",
	name: "Kimi For Coding",
	usesCallbackServer: false,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginKimi(callbacks);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshKimiToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
		const dynamicHeaders = getKimiCommonHeaders();
		return models.map((m) =>
			m.provider === "kimi-coding" ? { ...m, headers: { ...m.headers, ...dynamicHeaders } } : m,
		);
	},
};
