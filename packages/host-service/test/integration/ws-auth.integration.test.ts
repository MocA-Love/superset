import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestHost, type TestHost } from "../helpers/createTestHost";

describe("websocket route auth", () => {
	let host: TestHost;

	beforeEach(async () => {
		host = await createTestHost();
	});

	afterEach(async () => {
		await host.dispose();
	});

	test("/events rejects requests without auth header or token", async () => {
		const res = await host.fetch("http://host-service.test/events");
		expect(res.status).toBe(401);
	});

	test("/events rejects requests with a wrong token query param", async () => {
		const res = await host.fetch("http://host-service.test/events?token=wrong");
		expect(res.status).toBe(401);
	});

	test("/events with a valid token query param passes auth and reaches the WS handler", async () => {
		const res = await host.fetch(
			`http://host-service.test/events?token=${encodeURIComponent(host.psk)}`,
		);
		expect([404, 426]).toContain(res.status);
	});

	test("/terminal/* rejects requests without auth", async () => {
		const res = await host.fetch(
			"http://host-service.test/terminal/some-id?workspaceId=ws-1",
		);
		expect(res.status).toBe(401);
	});
});
