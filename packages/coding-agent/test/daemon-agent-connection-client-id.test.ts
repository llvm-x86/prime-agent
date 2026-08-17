import { describe, expect, it } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { DaemonClient } from "../src/modes/daemon/daemon-client.js";

function stubDaemonClient(): DaemonClient {
	return {
		socketPath: "/tmp/prime-agent-client-id-fixture/daemon.sock",
		onMessage: () => () => {},
		onClose: () => () => {},
		enableRequestRecovery: () => {},
	} as unknown as DaemonClient;
}

function clientIdOf(connection: DaemonAgentConnection): string {
	return (connection as unknown as { clientId: string }).clientId;
}

describe("daemon agent connection client id", () => {
	it("reuses one id across connections so a rebuilt connection keeps session ownership", () => {
		// The supervisor keys client-owned worker ownership on this id. A fresh id per
		// connection object made a reconnecting window fail attach with
		// "Unknown active session" and left its worker to be reaped.
		const first = new DaemonAgentConnection(stubDaemonClient(), "session-a");
		const second = new DaemonAgentConnection(stubDaemonClient(), "session-a");

		expect(clientIdOf(second)).toBe(clientIdOf(first));
	});

	it("namespaces the id so it cannot collide with other protocol client ids", () => {
		const connection = new DaemonAgentConnection(stubDaemonClient(), "session-a");

		expect(clientIdOf(connection)).toMatch(/^daemon-agent-connection:[0-9a-f-]{36}$/);
	});
});
