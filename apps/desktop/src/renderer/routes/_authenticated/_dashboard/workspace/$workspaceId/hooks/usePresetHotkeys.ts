import { type HotkeyId, useHotkey } from "renderer/hotkeys";

export const PRESET_HOTKEY_IDS: HotkeyId[] = [
	"OPEN_PRESET_1",
	"OPEN_PRESET_2",
	"OPEN_PRESET_3",
	"OPEN_PRESET_4",
	"OPEN_PRESET_5",
	"OPEN_PRESET_6",
	"OPEN_PRESET_7",
	"OPEN_PRESET_8",
	"OPEN_PRESET_9",
];

export function usePresetHotkeys(
	openTabWithPreset: (presetIndex: number) => void,
	options?: { enabled?: boolean },
) {
	useHotkey("OPEN_PRESET_1", () => openTabWithPreset(0), options);
	useHotkey("OPEN_PRESET_2", () => openTabWithPreset(1), options);
	useHotkey("OPEN_PRESET_3", () => openTabWithPreset(2), options);
	useHotkey("OPEN_PRESET_4", () => openTabWithPreset(3), options);
	useHotkey("OPEN_PRESET_5", () => openTabWithPreset(4), options);
	useHotkey("OPEN_PRESET_6", () => openTabWithPreset(5), options);
	useHotkey("OPEN_PRESET_7", () => openTabWithPreset(6), options);
	useHotkey("OPEN_PRESET_8", () => openTabWithPreset(7), options);
	useHotkey("OPEN_PRESET_9", () => openTabWithPreset(8), options);
}
