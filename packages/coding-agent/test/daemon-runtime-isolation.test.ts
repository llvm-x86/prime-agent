import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentDir, getLogsDir } from "../src/config.js";
import { DAEMON_SOCKET_DIR_ENV, defaultDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";

// A test run that resolves the developer's live ~/.prime/agent can discover and reap
// the worker backing an attached window. The setup file pins both the daemon socket
// directory and the agent directory; these assertions fail loudly if that stops
// happening, because the symptom otherwise shows up only as a killed live session.
describe("daemon runtime isolation", () => {
	const liveAgentDir = resolve(join(homedir(), ".prime", "agent"));

	it("pins the agent directory away from the developer's live agent dir", () => {
		const agentDir = resolve(getAgentDir());
		expect(process.env[ENV_AGENT_DIR]?.trim()).toBeTruthy();
		expect(agentDir).not.toBe(liveAgentDir);
		expect(agentDir.startsWith(`${liveAgentDir}/`)).toBe(false);
		expect(agentDir.startsWith(resolve(tmpdir()))).toBe(true);
	});

	it("keeps diagnostic logs out of the live agent dir", () => {
		// Fixture daemons write supervisor and client-error logs here; landing in the
		// live directory is the observable fingerprint of an unisolated run.
		expect(resolve(getLogsDir()).startsWith(resolve(getAgentDir()))).toBe(true);
		expect(resolve(getLogsDir())).not.toBe(resolve(join(liveAgentDir, "logs")));
	});

	it("pins the daemon socket directory per worker", () => {
		const socketDir = resolve(defaultDaemonSocketDir());
		expect(process.env[DAEMON_SOCKET_DIR_ENV]?.trim()).toBeTruthy();
		expect(socketDir).toContain(`prime-agent-test-${process.pid}`);
	});

	it("keeps the setup file's duplicated env names in sync with the exported constants", () => {
		// The setup file cannot import src/ without binding real dependencies before
		// test mocks register, so it hardcodes these names. Catch any rename here.
		expect(ENV_AGENT_DIR).toBe("PRIME_AGENT_CODING_AGENT_DIR");
		expect(DAEMON_SOCKET_DIR_ENV).toBe("PRIME_AGENT_DAEMON_SOCKET_DIR");
	});

	it("scopes the worker descriptor registry to the isolated agent dir", () => {
		// daemon-ps sweeps join(getAgentDir(), "daemon-workers") and stops what it
		// finds, so this path must never resolve into the live registry.
		const registry = resolve(join(getAgentDir(), "daemon-workers"));
		expect(registry).not.toBe(resolve(join(liveAgentDir, "daemon-workers")));
	});
});
