import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const OWNER_CLIENT_ID = "owner-client";
const ROOT_ACTIVE_SESSION_ID = "owned-active-session";

interface FakeClient {
	id: string;
	attachedActiveSessionIds: Set<string>;
}

interface FakeWorker {
	descriptor: {
		workerId: string;
		ownerClientId: string | undefined;
		rootActiveSessionId: string | undefined;
		rootSessionId?: string;
		lifecycle: string;
	};
	ownerCleanupTimer: ReturnType<typeof setTimeout> | undefined;
}

interface FakeSupervisor {
	scheduleOwnedWorkerCleanup(worker: FakeWorker): void;
	cancelOwnedWorkerCleanup(clientId: string): void;
	hasAttachedClient(worker: FakeWorker): boolean;
}

function buildSupervisor(clients: FakeClient[]) {
	const worker: FakeWorker = {
		descriptor: {
			workerId: "owned-worker",
			ownerClientId: OWNER_CLIENT_ID,
			rootActiveSessionId: ROOT_ACTIVE_SESSION_ID,
			lifecycle: "ready",
		},
		ownerCleanupTimer: undefined,
	};
	const stopWorker = vi.fn(async () => {});
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([[worker.descriptor.workerId, worker]]),
		clients: new Set(clients),
		protocolClientIds: new Map(),
		stopWorker,
		log: () => {},
	}) as FakeSupervisor;
	return { supervisor, worker, stopWorker };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("client-owned worker cleanup", () => {
	it("stops the worker once the owning client is gone and nobody is attached", async () => {
		vi.useFakeTimers();
		const { supervisor, worker, stopWorker } = buildSupervisor([]);

		supervisor.scheduleOwnedWorkerCleanup(worker);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(stopWorker).toHaveBeenCalledWith(worker, true);
	});

	it("keeps the worker alive while a reconnected client is still attached", async () => {
		vi.useFakeTimers();
		// A rebuilt connection reports a new protocol client id, so the owner lookup
		// misses it even though the window is attached and working.
		const reconnected: FakeClient = {
			id: "reconnected-client",
			attachedActiveSessionIds: new Set([ROOT_ACTIVE_SESSION_ID]),
		};
		const { supervisor, worker, stopWorker } = buildSupervisor([reconnected]);

		supervisor.scheduleOwnedWorkerCleanup(worker);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(stopWorker).not.toHaveBeenCalled();
		// Re-armed rather than abandoned, so the worker cannot leak.
		expect(worker.ownerCleanupTimer).toBeDefined();
	});

	it("reaps the worker once the attached client finally detaches", async () => {
		vi.useFakeTimers();
		const reconnected: FakeClient = {
			id: "reconnected-client",
			attachedActiveSessionIds: new Set([ROOT_ACTIVE_SESSION_ID]),
		};
		const { supervisor, worker, stopWorker } = buildSupervisor([reconnected]);

		supervisor.scheduleOwnedWorkerCleanup(worker);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(stopWorker).not.toHaveBeenCalled();

		reconnected.attachedActiveSessionIds.clear();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(stopWorker).toHaveBeenCalledWith(worker, true);
	});

	it("treats an attachment to the worker's root session id as attached", () => {
		const { supervisor, worker } = buildSupervisor([
			{ id: "reconnected-client", attachedActiveSessionIds: new Set(["some-other-session"]) },
		]);

		expect(supervisor.hasAttachedClient(worker)).toBe(false);

		worker.descriptor.rootActiveSessionId = "some-other-session";
		expect(supervisor.hasAttachedClient(worker)).toBe(true);
	});

	it("does not arm cleanup while the owning client is still connected", async () => {
		vi.useFakeTimers();
		const { supervisor, worker, stopWorker } = buildSupervisor([
			{ id: OWNER_CLIENT_ID, attachedActiveSessionIds: new Set() },
		]);

		supervisor.scheduleOwnedWorkerCleanup(worker);

		expect(worker.ownerCleanupTimer).toBeUndefined();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(stopWorker).not.toHaveBeenCalled();
	});

	it("cancels a pending cleanup when the owning client comes back", async () => {
		vi.useFakeTimers();
		const { supervisor, worker, stopWorker } = buildSupervisor([]);

		supervisor.scheduleOwnedWorkerCleanup(worker);
		expect(worker.ownerCleanupTimer).toBeDefined();

		supervisor.cancelOwnedWorkerCleanup(OWNER_CLIENT_ID);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(worker.ownerCleanupTimer).toBeUndefined();
		expect(stopWorker).not.toHaveBeenCalled();
	});

	it("leaves a worker alone once it is no longer the registered worker", async () => {
		vi.useFakeTimers();
		const { supervisor, worker, stopWorker } = buildSupervisor([]);

		supervisor.scheduleOwnedWorkerCleanup(worker);
		(supervisor as unknown as { workers: Map<string, unknown> }).workers.clear();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(stopWorker).not.toHaveBeenCalled();
	});
});
