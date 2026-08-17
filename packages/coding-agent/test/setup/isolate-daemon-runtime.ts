import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deliberately no `src/` imports. A setup file runs before each test module registers
// its `vi.mock` factories, so importing src here pulls those modules into the graph
// with their real dependencies already bound: importing config.ts, for example, binds
// the real child_process and makes `npm root -g` run for real in tests that mock it.
// The env var names are duplicated as literals and pinned by
// test/daemon-runtime-isolation.test.ts, which asserts they match the exported
// constants from a normal test context where importing src is safe.
const DAEMON_SOCKET_DIR_ENV = "PRIME_AGENT_DAEMON_SOCKET_DIR";
const ENV_AGENT_DIR = "PRIME_AGENT_CODING_AGENT_DIR";

const runtimeRoot = join(tmpdir(), `prime-agent-test-${process.pid}`);

// The default daemon runtime directory is shared per uid and follows TMPDIR, so an
// unisolated test run resolves to the developer's live daemon directory. Tests then
// contend for the supervisor ownership registry there and the live daemon stands
// down, killing every attached session. Pin each vitest worker to its own directory.
if (!process.env[DAEMON_SOCKET_DIR_ENV]?.trim()) {
	mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
	process.env[DAEMON_SOCKET_DIR_ENV] = runtimeRoot;
}

// Isolating the socket directory alone is not enough: the agent directory holds the
// worker descriptor registry, diagnostic logs, and leases, so an unpinned run reads
// and writes the developer's live ~/.prime/agent while a real session is attached.
// Fixture daemons landing there are how a live worker gets discovered and reaped.
// The kernel venv resolves from homedir rather than the agent dir, so pinning this
// does not force every suite to rebuild a virtualenv.
if (!process.env[ENV_AGENT_DIR]?.trim()) {
	const agentDir = join(runtimeRoot, "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	process.env[ENV_AGENT_DIR] = agentDir;
}
