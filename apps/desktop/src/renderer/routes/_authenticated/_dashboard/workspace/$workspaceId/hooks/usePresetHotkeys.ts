import { useAppHotkey } from "renderer/stores/hotkeys";
import type { HotkeyId } from "shared/hotkeys";

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
	useAppHotkey(PRESET_HOTKEY_IDS[0], () => openTabWithPreset(0), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[1], () => openTabWithPreset(1), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[2], () => openTabWithPreset(2), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[3], () => openTabWithPreset(3), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[4], () => openTabWithPreset(4), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[5], () => openTabWithPreset(5), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[6], () => openTabWithPreset(6), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[7], () => openTabWithPreset(7), options, [
		openTabWithPreset,
	]);
	useAppHotkey(PRESET_HOTKEY_IDS[8], () => openTabWithPreset(8), options, [
		openTabWithPreset,
	]);
}
