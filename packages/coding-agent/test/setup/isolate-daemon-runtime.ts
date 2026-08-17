import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_SOCKET_DIR_ENV } from "../../src/modes/daemon/daemon-socket.js";

// The default daemon runtime directory is shared per uid and follows TMPDIR, so an
// unisolated test run resolves to the developer's live daemon directory. Tests then
// contend for the supervisor ownership registry there and the live daemon stands
// down, killing every attached session. Pin each vitest worker to its own directory.
if (!process.env[DAEMON_SOCKET_DIR_ENV]?.trim()) {
	const socketDir = join(tmpdir(), `prime-agent-test-${process.pid}`);
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	process.env[DAEMON_SOCKET_DIR_ENV] = socketDir;
}
