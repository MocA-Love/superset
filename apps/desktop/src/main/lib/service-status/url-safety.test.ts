import { describe, expect, it } from "bun:test";
import {
	extractV4MappedToIPv6,
	isPublicHttpsHost,
	parseSafeHttpUrl,
} from "./url-safety";

describe("service-status URL safety", () => {
	it("allows public http and https URLs", () => {
		expect(
			parseSafeHttpUrl("https://status.example.com/api/v2/status.json")
				?.hostname,
		).toBe("status.example.com");
		expect(parseSafeHttpUrl("http://8.8.8.8/status")?.hostname).toBe("8.8.8.8");
		expect(isPublicHttpsHost("2606:4700:4700::1111")).toBe(true);
	});

	it("rejects non-http protocols", () => {
		expect(parseSafeHttpUrl("file:///etc/passwd")).toBeNull();
		expect(parseSafeHttpUrl("ftp://status.example.com/feed")).toBeNull();
		expect(parseSafeHttpUrl("javascript:alert(1)")).toBeNull();
	});

	it("rejects localhost and private IPv4 ranges", () => {
		for (const url of [
			"https://localhost/status",
			"https://localhost./status",
			"https://127.0.0.1/status",
			"https://127.42.0.1/status",
			"https://0.0.0.0/status",
			"https://10.0.0.1/status",
			"https://192.168.1.1/status",
			"https://172.16.0.1/status",
			"https://172.31.255.255/status",
			"https://169.254.169.254/latest/meta-data",
		]) {
			expect(parseSafeHttpUrl(url)).toBeNull();
		}
	});

	it("rejects loopback, link-local, and private IPv6 ranges", () => {
		for (const host of [
			"::1",
			"[::1]",
			"fe80::1",
			"[fe80::1]",
			"fc00::1",
			"fd12:3456:789a::1",
		]) {
			expect(isPublicHttpsHost(host)).toBe(false);
		}
	});

	it("rejects IPv4-mapped IPv6 private addresses", () => {
		expect(extractV4MappedToIPv6("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(extractV4MappedToIPv6("::ffff:0a00:0001")).toBe("10.0.0.1");
		expect(isPublicHttpsHost("::ffff:127.0.0.1")).toBe(false);
		expect(isPublicHttpsHost("::ffff:0a00:0001")).toBe(false);
		expect(isPublicHttpsHost("[::ffff:192.168.0.1]")).toBe(false);
	});

	it("rejects malformed URLs and empty hosts", () => {
		expect(parseSafeHttpUrl("not a url")).toBeNull();
		expect(isPublicHttpsHost("")).toBe(false);
	});
});
