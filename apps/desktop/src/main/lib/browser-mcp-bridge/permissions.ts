import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SUPERSET_HOME_DIR } from "../app-environment";

/**
 * CDP permission presets.
 *
 * The filter proxy's deny list used to be fully hardcoded, which was
 * too rigid: it broke legitimate frontend-dev workflows (can't read
 * cookies from a local app under MCP automation) while still not
 * covering every edge case.
 *
 * The new model: a small set of capability toggles, grouped into
 * user-named presets. The user switches the active preset from the
 * Connect modal; the filter re-reads toggles on every request and
 * active proxies are force-closed so the MCP reconnects under the
 * fresh scope.
 *
 * Some CDP methods are ALWAYS denied (Browser.close, Page.close,
 * Target.createBrowserContext, …). These are not part of the toggle
 * set because honouring them would trash the user-visible pane or
 * escape the pane sandbox entirely; they have no legitimate use in
 * automation against a Superset-managed pane.
 */

export type PermissionToggleKey =
	| "cookieRead"
	| "cookieWrite"
	| "storageWrite"
	| "permissions"
	| "privilegedSchemes"
	| "downloadOverride"
	| "uaOverride"
	| "debugger"
	| "networkIntercept";

export const PERMISSION_TOGGLE_KEYS: PermissionToggleKey[] = [
	"cookieRead",
	"cookieWrite",
	"storageWrite",
	"permissions",
	"privilegedSchemes",
	"downloadOverride",
	"uaOverride",
	"debugger",
	"networkIntercept",
];

export interface PermissionToggleMeta {
	key: PermissionToggleKey;
	label: string;
	description: string;
	/** CDP methods this toggle controls (documentation only). */
	methods: string[];
}

export const PERMISSION_TOGGLE_META: Record<
	PermissionToggleKey,
	PermissionToggleMeta
> = {
	cookieRead: {
		key: "cookieRead",
		label: "Cookie 読み取り",
		description:
			"Cookie 一覧の取得を許可します。フロント開発で認証 Cookie を確認したいときに有効化。",
		methods: [
			"Network.getCookies",
			"Network.getAllCookies",
			"Storage.getCookies",
		],
	},
	cookieWrite: {
		key: "cookieWrite",
		label: "Cookie 書き込み / 削除",
		description:
			"Cookie の設定・削除を許可します。MCP でセッションを差し替えたい場合のみ。",
		methods: [
			"Network.setCookie",
			"Network.setCookies",
			"Network.clearBrowserCookies",
			"Storage.setCookie",
			"Storage.setCookies",
			"Storage.clearCookies",
		],
	},
	storageWrite: {
		key: "storageWrite",
		label: "Storage 変更",
		description:
			"localStorage / IndexedDB / origin-scoped storage の書き換え・削除を許可します。",
		methods: [
			"Storage.clearDataForOrigin",
			"Storage.clearDataForStorageKey",
			"DOMStorage.clear",
			"DOMStorage.setDOMStorageItem",
			"DOMStorage.removeDOMStorageItem",
			"DOMStorage.getDOMStorageItems",
		],
	},
	permissions: {
		key: "permissions",
		label: "ブラウザ権限付与",
		description:
			"通知 / 位置情報 / カメラ等のブラウザ権限を MCP から操作することを許可します。全ペイン共有なので要注意。",
		methods: [
			"Browser.grantPermissions",
			"Browser.resetPermissions",
			"Browser.setPermission",
		],
	},
	privilegedSchemes: {
		key: "privilegedSchemes",
		label: "特権スキーム navigate",
		description:
			"file:// / chrome:// / devtools:// / javascript: への createTarget を許可します。通常は http(s) のみ。",
		methods: ["Target.createTarget (url scheme)"],
	},
	downloadOverride: {
		key: "downloadOverride",
		label: "ダウンロード先上書き",
		description:
			"Browser.setDownloadBehavior で任意パスへのダウンロードを許可します。任意パス書き込みの起点になるので注意。",
		methods: ["Browser.setDownloadBehavior"],
	},
	uaOverride: {
		key: "uaOverride",
		label: "User-Agent 上書き",
		description:
			"Network.setUserAgentOverride を許可。partition-wide なので他ペインにも影響します。",
		methods: ["Network.setUserAgentOverride"],
	},
	debugger: {
		key: "debugger",
		label: "Debugger ドメイン",
		description:
			"JS デバッガー操作を許可。Runtime.evaluate と同等の実行権限を持ちます。",
		methods: ["Debugger.*"],
	},
	networkIntercept: {
		key: "networkIntercept",
		label: "Fetch / Network 書き換え",
		description:
			"Fetch.enable 系でリクエスト/レスポンスの MITM 的改ざんを許可します。",
		methods: [
			"Fetch.enable",
			"Fetch.continueRequest",
			"Fetch.fulfillRequest",
			"Fetch.failRequest",
		],
	},
};

export type PermissionToggles = Partial<Record<PermissionToggleKey, boolean>>;

export interface PermissionPreset {
	id: string;
	name: string;
	/** Built-in presets cannot be renamed or deleted. */
	builtin?: boolean;
	toggles: PermissionToggles;
}

export interface PermissionConfig {
	presets: PermissionPreset[];
	activePresetId: string;
}

const BUILTIN_SECURE: PermissionPreset = {
	id: "builtin-secure",
	name: "Secure (default)",
	builtin: true,
	toggles: {
		cookieRead: false,
		cookieWrite: false,
		storageWrite: false,
		permissions: false,
		privilegedSchemes: false,
		downloadOverride: false,
		uaOverride: false,
		debugger: false,
		networkIntercept: false,
	},
};

const BUILTIN_FRONTEND_DEV: PermissionPreset = {
	id: "builtin-frontend-dev",
	name: "Frontend Dev",
	builtin: true,
	toggles: {
		cookieRead: true,
		cookieWrite: false,
		storageWrite: true,
		permissions: false,
		privilegedSchemes: false,
		downloadOverride: false,
		uaOverride: true,
		debugger: true,
		networkIntercept: true,
	},
};

const BUILTIN_PERMISSIVE: PermissionPreset = {
	id: "builtin-permissive",
	name: "Permissive",
	builtin: true,
	toggles: {
		cookieRead: true,
		cookieWrite: true,
		storageWrite: true,
		permissions: true,
		privilegedSchemes: true,
		downloadOverride: true,
		uaOverride: true,
		debugger: true,
		networkIntercept: true,
	},
};

export const BUILTIN_PRESETS: PermissionPreset[] = [
	BUILTIN_SECURE,
	BUILTIN_FRONTEND_DEV,
	BUILTIN_PERMISSIVE,
];

const CONFIG_PATH = join(SUPERSET_HOME_DIR, "browser-mcp-permissions.json");

interface StoreEvents {
	change: [config: PermissionConfig];
	activeChanged: [presetId: string];
}

class PermissionStore extends EventEmitter<StoreEvents> {
	private config: PermissionConfig = {
		presets: BUILTIN_PRESETS.map((p) => ({
			...p,
			toggles: { ...p.toggles },
		})),
		activePresetId: BUILTIN_SECURE.id,
	};

	constructor() {
		super();
		this.load();
	}

	private load(): void {
		if (!existsSync(CONFIG_PATH)) return;
		try {
			const raw = readFileSync(CONFIG_PATH, "utf-8");
			const parsed = JSON.parse(raw) as Partial<PermissionConfig>;
			const userPresets = Array.isArray(parsed.presets)
				? parsed.presets.filter(
						(p): p is PermissionPreset =>
							!!p && typeof p.id === "string" && typeof p.name === "string",
					)
				: [];
			// Merge builtin + user. Builtins always come first and
			// override any stored copy (so we can update defaults
			// without the user's file sticking on stale values).
			const byId = new Map<string, PermissionPreset>();
			for (const p of BUILTIN_PRESETS) {
				byId.set(p.id, { ...p, toggles: { ...p.toggles } });
			}
			for (const p of userPresets) {
				if (byId.has(p.id) && byId.get(p.id)?.builtin) continue;
				byId.set(p.id, {
					...p,
					builtin: false,
					toggles: { ...p.toggles },
				});
			}
			const active =
				typeof parsed.activePresetId === "string" &&
				byId.has(parsed.activePresetId)
					? parsed.activePresetId
					: BUILTIN_SECURE.id;
			this.config = {
				presets: Array.from(byId.values()),
				activePresetId: active,
			};
		} catch (error) {
			console.warn("[permissions] failed to load config:", error);
		}
	}

	private persist(): void {
		try {
			mkdirSync(dirname(CONFIG_PATH), { recursive: true });
			writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), {
				mode: 0o600,
			});
			try {
				chmodSync(CONFIG_PATH, 0o600);
			} catch {
				/* best effort */
			}
		} catch (error) {
			console.warn("[permissions] failed to persist config:", error);
		}
	}

	getConfig(): PermissionConfig {
		return {
			presets: this.config.presets.map((p) => ({
				...p,
				toggles: { ...p.toggles },
			})),
			activePresetId: this.config.activePresetId,
		};
	}

	getActive(): PermissionPreset {
		const found = this.config.presets.find(
			(p) => p.id === this.config.activePresetId,
		);
		return found ?? BUILTIN_SECURE;
	}

	getActiveToggles(): PermissionToggles {
		return this.getActive().toggles;
	}

	setActive(presetId: string): void {
		if (!this.config.presets.some((p) => p.id === presetId)) {
			throw new Error(`Unknown preset id: ${presetId}`);
		}
		if (this.config.activePresetId === presetId) return;
		this.config.activePresetId = presetId;
		this.persist();
		this.emit("activeChanged", presetId);
		this.emit("change", this.getConfig());
	}

	savePreset(input: {
		id?: string;
		name: string;
		toggles: PermissionToggles;
	}): PermissionPreset {
		const id = input.id ?? `user-${Date.now().toString(36)}`;
		const existing = this.config.presets.find((p) => p.id === id);
		if (existing?.builtin) {
			throw new Error(`Cannot modify built-in preset: ${id}`);
		}
		const next: PermissionPreset = {
			id,
			name: input.name,
			builtin: false,
			toggles: { ...input.toggles },
		};
		if (existing) {
			this.config.presets = this.config.presets.map((p) =>
				p.id === id ? next : p,
			);
		} else {
			this.config.presets = [...this.config.presets, next];
		}
		this.persist();
		this.emit("change", this.getConfig());
		// If the edited preset is the active one, notify filter to
		// re-close connections so the MCP picks up new toggles.
		if (this.config.activePresetId === id) {
			this.emit("activeChanged", id);
		}
		return next;
	}

	deletePreset(id: string): void {
		const existing = this.config.presets.find((p) => p.id === id);
		if (!existing) return;
		if (existing.builtin) {
			throw new Error(`Cannot delete built-in preset: ${id}`);
		}
		this.config.presets = this.config.presets.filter((p) => p.id !== id);
		if (this.config.activePresetId === id) {
			this.config.activePresetId = BUILTIN_SECURE.id;
			this.emit("activeChanged", this.config.activePresetId);
		}
		this.persist();
		this.emit("change", this.getConfig());
	}
}

export const permissionStore = new PermissionStore();

/**
 * Classify a CDP method into (a) always-denied, (b) toggle-gated,
 * or (c) always-allowed.
 *
 * The filter proxy calls this before forwarding any message and
 * consults the current active preset's toggles. Returning
 * {allowed:false} causes the filter to reply with -32000.
 */
export interface PermissionCheckResult {
	allowed: boolean;
	reason?: string;
	/**
	 * When false, indicates the method is gated by a toggle that is
	 * currently OFF. UI surfaces this so the user can flip the
	 * relevant preset toggle.
	 */
	togglesKey?: PermissionToggleKey;
}

const ALWAYS_DENIED = new Set<string>([
	"Target.createBrowserContext",
	"Target.disposeBrowserContext",
	// Target.getBrowserContexts is READ-ONLY and required by
	// puppeteer.connect() bootstrap — NOT denied.
	"Target.setRemoteLocations",
	"Target.exposeDevToolsProtocol",
	"Browser.close",
	"Browser.crash",
	"Browser.crashGpuProcess",
	"Page.setWebLifecycleState",
	"Page.close",
]);

const TOGGLE_BY_METHOD: Record<string, PermissionToggleKey> = {
	// cookieRead
	"Network.getCookies": "cookieRead",
	"Network.getAllCookies": "cookieRead",
	"Storage.getCookies": "cookieRead",
	// cookieWrite
	"Network.setCookie": "cookieWrite",
	"Network.setCookies": "cookieWrite",
	"Network.clearBrowserCookies": "cookieWrite",
	"Storage.setCookie": "cookieWrite",
	"Storage.setCookies": "cookieWrite",
	"Storage.clearCookies": "cookieWrite",
	// storageWrite
	"Storage.clearDataForOrigin": "storageWrite",
	"Storage.clearDataForStorageKey": "storageWrite",
	"DOMStorage.clear": "storageWrite",
	"DOMStorage.setDOMStorageItem": "storageWrite",
	"DOMStorage.removeDOMStorageItem": "storageWrite",
	"DOMStorage.getDOMStorageItems": "storageWrite",
	// permissions
	"Browser.grantPermissions": "permissions",
	"Browser.resetPermissions": "permissions",
	"Browser.setPermission": "permissions",
	// downloadOverride
	"Browser.setDownloadBehavior": "downloadOverride",
	// uaOverride
	"Network.setUserAgentOverride": "uaOverride",
	// networkIntercept
	"Fetch.enable": "networkIntercept",
	"Fetch.continueRequest": "networkIntercept",
	"Fetch.fulfillRequest": "networkIntercept",
	"Fetch.failRequest": "networkIntercept",
	"Fetch.continueResponse": "networkIntercept",
	"Fetch.continueWithAuth": "networkIntercept",
};

export function checkMethodPermitted(
	method: string,
	toggles: PermissionToggles,
): PermissionCheckResult {
	if (ALWAYS_DENIED.has(method)) {
		return {
			allowed: false,
			reason: `${method} is always denied by the Superset CDP filter (pane lifecycle / scope escape).`,
		};
	}
	if (method.startsWith("Debugger.")) {
		if (!toggles.debugger) {
			return {
				allowed: false,
				reason: `${method} requires the Debugger permission toggle.`,
				togglesKey: "debugger",
			};
		}
		return { allowed: true };
	}
	const tog = TOGGLE_BY_METHOD[method];
	if (!tog) return { allowed: true };
	if (!toggles[tog]) {
		return {
			allowed: false,
			reason: `${method} requires the "${PERMISSION_TOGGLE_META[tog].label}" permission toggle.`,
			togglesKey: tog,
		};
	}
	return { allowed: true };
}

/**
 * Scheme check for Target.createTarget url param. Returns true when
 * the current toggles allow privileged schemes (file:, chrome:,
 * devtools:, javascript:, data:). http(s) and about:blank are always
 * allowed.
 */
export function isPrivilegedSchemeAllowed(toggles: PermissionToggles): boolean {
	return toggles.privilegedSchemes === true;
}
