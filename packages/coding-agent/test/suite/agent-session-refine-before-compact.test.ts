import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type CompactionInternals = {
	_runAutoCompaction(reason: "threshold" | "overflow" | "requested", willRetry: boolean): Promise<boolean>;
	_refineBeforeCompaction(): Promise<boolean>;
	_scheduleAutoRefine(reason: string, branchVersion?: number): void;
	_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
	_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
	_applyRefine(plan: unknown, options: unknown, abort: AbortController): Promise<unknown>;
	_compactAutoRefinePending: boolean;
	_refinedBeforeCompaction: boolean;
};

/**
 * Records the order of refine review vs. the compaction summarizer, and keeps
 * both off the network: the reviewer decision is injected and the summary comes
 * from an extension hook.
 */
async function createCompactionHarness(
	autoRefine: Record<string, unknown>,
	order: string[],
	reviewer = vi.fn(async () => ({
		shouldRefine: true,
		rationale: "durable lesson",
		instructions: "capture the lesson",
	})),
) {
	const harness = await createHarness({
		persistSession: true,
		settings: {
			compaction: { enabled: true, keepRecentTokens: 1 },
			autoRefine: { cooldownMs: 0, ...autoRefine },
		},
		autoRefineReviewer: vi.fn(async (...args: unknown[]) => {
			order.push("refine");
			return await (reviewer as (...inner: unknown[]) => Promise<unknown>)(...args);
		}) as never,
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					order.push("compact");
					return {
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					};
				});
			},
		],
	});
	const internals = harness.session as unknown as CompactionInternals;
	vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "test-plan", proposal: { edits: [] } });
	vi.spyOn(internals, "_applyRefine").mockResolvedValue(undefined);
	return { harness, internals, reviewer };
}

describe("refine before auto-compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("refines before the summarizer runs when autoRefine.beforeCompact is set", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true, beforeCompact: true }, order);
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await internals._runAutoCompaction("threshold", false);

		// Refinement must see the context compaction is about to discard.
		expect(order).toEqual(["refine", "compact"]);
		expect(internals._applyRefine).toHaveBeenCalled();
	});

	it("skips the post-compaction pass after refining beforehand", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true, beforeCompact: true }, order);
		harnesses.push(harness);
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine");
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await internals._runAutoCompaction("threshold", false);

		// A second pass would only review the summary the first pass just produced.
		expect(scheduleAutoRefine).not.toHaveBeenCalledWith("compact");
		expect(internals._compactAutoRefinePending).toBe(false);
	});

	it("keeps refining after compaction by default", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true }, order);
		harnesses.push(harness);
		const scheduleAfter = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await internals._runAutoCompaction("threshold", false);

		expect(order).toEqual(["compact"]);
		expect(scheduleAfter).toHaveBeenCalled();
	});

	it("does not refine before compaction while auto-refine is disabled", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: false, beforeCompact: true }, order);
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await internals._runAutoCompaction("threshold", false);

		expect(order).toEqual(["compact"]);
	});

	it("honors the autoRefine.compact opt-out even when beforeCompact is set", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness(
			{ enabled: true, beforeCompact: true, compact: false },
			order,
		);
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await internals._runAutoCompaction("threshold", false);

		expect(order).toEqual(["compact"]);
	});

	it("refines again on the next compaction instead of latching after the first", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true, beforeCompact: true }, order);
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await internals._runAutoCompaction("threshold", false);
		expect(internals._refinedBeforeCompaction).toBe(false);

		await harness.session.prompt("three");
		await harness.session.prompt("four");
		await internals._runAutoCompaction("threshold", false);

		expect(order).toEqual(["refine", "compact", "refine", "compact"]);
	});

	it("refines before the summarizer on a manual /compact", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true, beforeCompact: true }, order);
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await harness.session.compact();

		// Manual compaction discards the same context an auto one would.
		expect(order).toEqual(["refine", "compact"]);
		expect(internals._applyRefine).toHaveBeenCalled();
	});

	it("skips the post-compaction pass after a manual /compact refined beforehand", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true, beforeCompact: true }, order);
		harnesses.push(harness);
		const scheduleAutoRefine = vi.spyOn(internals, "_scheduleAutoRefine");
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await harness.session.compact();

		expect(scheduleAutoRefine).not.toHaveBeenCalledWith("compact");
		expect(internals._compactAutoRefinePending).toBe(false);
		// Never latched: a later compaction re-evaluates the setting.
		expect(internals._refinedBeforeCompaction).toBe(false);
	});

	it("still refines after a manual /compact by default", async () => {
		const order: string[] = [];
		const { harness, internals } = await createCompactionHarness({ enabled: true }, order);
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		await harness.session.compact();

		// Without the opt-in, the pre-pass must not fire and the existing
		// post-compaction behavior must be untouched.
		expect(order).toEqual(["compact"]);
		expect(internals._refinedBeforeCompaction).toBe(false);
	});
});
