/**
 * VS Code Uri shim.
 */

import path from "node:path";
import { URL } from "node:url";

export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;

	private constructor(
		scheme: string,
		authority: string,
		uriPath: string,
		query: string,
		fragment: string,
	) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = uriPath;
		this.query = query;
		this.fragment = fragment;
	}

	get fsPath(): string {
		if (this.scheme === "file") {
			return this.path.startsWith("/") ? this.path : `/${this.path}`;
		}
		return this.path;
	}

	with(change: {
		scheme?: string;
		authority?: string;
		path?: string;
		query?: string;
		fragment?: string;
	}): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}

	toString(): string {
		if (this.scheme === "file") {
			return `file://${this.path}`;
		}
		let result = `${this.scheme}://`;
		if (this.authority) result += this.authority;
		result += this.path;
		if (this.query) result += `?${this.query}`;
		if (this.fragment) result += `#${this.fragment}`;
		return result;
	}

	toJSON(): {
		scheme: string;
		authority: string;
		path: string;
		query: string;
		fragment: string;
	} {
		return {
			scheme: this.scheme,
			authority: this.authority,
			path: this.path,
			query: this.query,
			fragment: this.fragment,
		};
	}

	static file(filePath: string): Uri {
		const normalized = filePath.replace(/\\/g, "/");
		return new Uri("file", "", normalized, "", "");
	}

	static parse(value: string): Uri {
		try {
			const url = new URL(value);
			return new Uri(
				url.protocol.replace(":", ""),
				url.hostname + (url.port ? `:${url.port}` : ""),
				decodeURIComponent(url.pathname),
				url.search.replace("?", ""),
				url.hash.replace("#", ""),
			);
		} catch {
			return Uri.file(value);
		}
	}

	static from(components: {
		scheme: string;
		authority?: string;
		path?: string;
		query?: string;
		fragment?: string;
	}): Uri {
		return new Uri(
			components.scheme,
			components.authority ?? "",
			components.path ?? "",
			components.query ?? "",
			components.fragment ?? "",
		);
	}

	static joinPath(base: Uri, ...pathSegments: string[]): Uri {
		const joined = path.posix.join(base.path, ...pathSegments);
		return base.with({ path: joined });
	}
}
