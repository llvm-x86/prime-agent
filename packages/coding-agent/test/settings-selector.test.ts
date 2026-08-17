import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const config: SettingsConfig = {
	autoCompact: true,
	idleEvictionMinutes: 90,
	showImages: true,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	enableBuiltinSkills: true,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "sse",
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
	currentTheme: "dark",
	availableThemes: ["dark"],
	hideThinkingBlock: false,
	treeFilterMode: "user-only",
	showHardwareCursor: false,
	editorPaddingX: 0,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	clearOnShrink: false,
	showTerminalProgress: false,
	fullscreen: true,
	warnings: {},
};

const callbacks: SettingsCallbacks = {
	onAutoCompactChange: () => {},
	onIdleEvictionMinutesChange: () => {},
	onShowImagesChange: () => {},
	onAutoResizeImagesChange: () => {},
	onBlockImagesChange: () => {},
	onEnableSkillCommandsChange: () => {},
	onEnableBuiltinSkillsChange: () => {},
	onSteeringModeChange: () => {},
	onFollowUpModeChange: () => {},
	onTransportChange: () => {},
	onThinkingLevelChange: () => {},
	onThemeChange: () => {},
	onHideThinkingBlockChange: () => {},
	onTreeFilterModeChange: () => {},
	onShowHardwareCursorChange: () => {},
	onEditorPaddingXChange: () => {},
	onAutocompleteMaxVisibleChange: () => {},
	onQuietStartupChange: () => {},
	onClearOnShrinkChange: () => {},
	onShowTerminalProgressChange: () => {},
	onFullscreenChange: () => {},
	onWarningsChange: () => {},
	onCancel: () => {},
	onCompactionThresholdTokensChange: () => {},
};

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the image metadata toggle without a terminal graphics protocol", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			const component = new SettingsSelectorComponent(config, callbacks);
			const rendered = stripAnsi(component.render(120).join("\n"));

			expect(rendered).toContain("Show image metadata");
			expect(rendered).toContain("Auto-resize images");
			for (const character of "idle") component.getSettingsList().handleInput(character);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Idle worker eviction");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("cycles a custom idle eviction value to the next numeric option", () => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: 120 },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenCalledWith(180);
	});

	test.each([0.5, 1.5])("round-trips a fractional idle eviction value of %s", (value) => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: value },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		// Cycle through every option and back onto the custom fractional value.
		for (let index = 0; index < 7; index++) list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenLastCalledWith(value);
		expect(stripAnsi(component.render(120).join("\n"))).toContain(String(value));
	});

	const openThresholdSubmenu = (
		compactionThresholdTokens: number | undefined,
		onCompactionThresholdTokensChange: SettingsCallbacks["onCompactionThresholdTokensChange"],
	) => {
		const component = new SettingsSelectorComponent(
			{ ...config, compactionThresholdTokens },
			{ ...callbacks, onCompactionThresholdTokensChange },
		);
		const list = component.getSettingsList();
		for (const character of "threshold") list.handleInput(character);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Auto-compact threshold");
		list.handleInput("\r");
		return { component, list };
	};

	test("opens a threshold submenu offering off, presets, and a custom entry", () => {
		const { component } = openThresholdSubmenu(undefined, vi.fn());
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("off");
		expect(rendered).toContain("40,000");
		expect(rendered).toContain("Custom…");
	});

	test("selects a preset threshold from the submenu", () => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { list } = openThresholdSubmenu(undefined, onCompactionThresholdTokensChange);

		// "off" is preselected; step down once to the first preset.
		list.handleInput("\x1b[B");
		list.handleInput("\r");

		expect(onCompactionThresholdTokensChange).toHaveBeenCalledWith(40_000);
	});

	test("selecting 'off' clears the threshold instead of passing a number", () => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { list } = openThresholdSubmenu(200_000, onCompactionThresholdTokensChange);

		// 200000 is preselected; walk back up to "off" at the top of the list.
		for (let index = 0; index < 5; index++) list.handleInput("\x1b[A");
		list.handleInput("\r");

		expect(onCompactionThresholdTokensChange).toHaveBeenLastCalledWith(undefined);
	});

	test("keeps a custom threshold in the submenu so it can be reselected", () => {
		const { component } = openThresholdSubmenu(55_000, vi.fn());

		expect(stripAnsi(component.render(120).join("\n"))).toContain("55,000");
	});

	/** Options are off + 5 presets + "Custom…", so "Custom…" is the last entry. */
	const typeCustomThreshold = (
		list: ReturnType<SettingsSelectorComponent["getSettingsList"]>,
		text: string,
		selectedIndex = 0,
	) => {
		// Walking up past the top wraps onto the trailing "Custom…" entry.
		for (let step = 0; step <= selectedIndex; step++) list.handleInput("\x1b[A");
		list.handleInput("\r");
		for (const character of text) list.handleInput(character);
		list.handleInput("\r");
	};

	test("accepts a typed threshold value", () => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { list } = openThresholdSubmenu(undefined, onCompactionThresholdTokensChange);

		typeCustomThreshold(list, "37500");

		expect(onCompactionThresholdTokensChange).toHaveBeenCalledWith(37_500);
	});

	test("accepts a typed threshold with digit grouping", () => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { list } = openThresholdSubmenu(undefined, onCompactionThresholdTokensChange);

		typeCustomThreshold(list, "120,000");

		expect(onCompactionThresholdTokensChange).toHaveBeenCalledWith(120_000);
	});

	test("treats a typed 'off' as clearing the threshold", () => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { list } = openThresholdSubmenu(80_000, onCompactionThresholdTokensChange);

		typeCustomThreshold(list, "off", 2);

		expect(onCompactionThresholdTokensChange).toHaveBeenCalledWith(undefined);
	});

	test("treats an empty typed threshold as leaving the value unchanged", () => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { list } = openThresholdSubmenu(80_000, onCompactionThresholdTokensChange);

		typeCustomThreshold(list, "", 2);

		expect(onCompactionThresholdTokensChange).not.toHaveBeenCalled();
	});

	test.each(["abc", "0", "-5", "1.5"])("rejects the typed threshold %s without applying it", (text) => {
		const onCompactionThresholdTokensChange = vi.fn();
		const { component, list } = openThresholdSubmenu(undefined, onCompactionThresholdTokensChange);

		typeCustomThreshold(list, text);

		expect(onCompactionThresholdTokensChange).not.toHaveBeenCalled();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("positive whole number");
	});
});
