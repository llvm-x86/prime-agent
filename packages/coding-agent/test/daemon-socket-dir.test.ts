import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DAEMON_SOCKET_DIR_ENV,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

const original = process.env[DAEMON_SOCKET_DIR_ENV];

afterEach(() => {
	if (original === undefined) {
		delete process.env[DAEMON_SOCKET_DIR_ENV];
	} else {
		process.env[DAEMON_SOCKET_DIR_ENV] = original;
	}
});

describe("daemon runtime directory isolation", () => {
	it("prefers the override directory over the shared per-uid default", () => {
		const override = join(tmpdir(), "prime-agent-override-fixture");
		process.env[DAEMON_SOCKET_DIR_ENV] = override;
		expect(defaultDaemonSocketDir()).toBe(resolve(override));
		expect(defaultDaemonSocketPath()).toBe(join(resolve(override), "daemon.sock"));
	});

	it("ignores a blank override and falls back to the per-uid default", () => {
		process.env[DAEMON_SOCKET_DIR_ENV] = "   ";
		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		expect(defaultDaemonSocketDir()).toBe(join(tmpdir(), `prime-agent-${suffix}`));
	});

	it("keeps the test suite out of the developer's live daemon directory", () => {
		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		expect(defaultDaemonSocketDir()).not.toBe(join(tmpdir(), `prime-agent-${suffix}`));
	});
});
