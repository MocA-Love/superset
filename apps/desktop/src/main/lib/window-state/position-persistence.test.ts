import { afterEach, describe, expect, it } from "bun:test";
import {
	isWindowPositionPersistenceEnabled,
	setWindowStateEnvironmentForTesting,
} from "./position-persistence";

afterEach(() => {
	setWindowStateEnvironmentForTesting(null);
});

describe("isWindowPositionPersistenceEnabled", () => {
	it("should disable position persistence on Linux Wayland", () => {
		setWindowStateEnvironmentForTesting({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
			},
		});

		expect(isWindowPositionPersistenceEnabled()).toBe(false);
	});

	it("should disable position persistence when WAYLAND_DISPLAY is set", () => {
		setWindowStateEnvironmentForTesting({
			platform: "linux",
			env: {
				WAYLAND_DISPLAY: "wayland-1",
			},
		});

		expect(isWindowPositionPersistenceEnabled()).toBe(false);
	});

	it("should keep position persistence on Linux X11", () => {
		setWindowStateEnvironmentForTesting({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "x11",
			},
		});

		expect(isWindowPositionPersistenceEnabled()).toBe(true);
	});

	it("should keep position persistence on non-Linux platforms", () => {
		setWindowStateEnvironmentForTesting({
			platform: "darwin",
			env: {
				XDG_SESSION_TYPE: "wayland",
			},
		});

		expect(isWindowPositionPersistenceEnabled()).toBe(true);
	});
});
