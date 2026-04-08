interface PersistentVscodeExtensionHost {
	wrapper: HTMLDivElement;
	iframe: HTMLIFrameElement;
	viewId: string;
}

const hostRegistry = new Map<string, PersistentVscodeExtensionHost>();
let hiddenContainer: HTMLDivElement | null = null;

function getHiddenContainer(): HTMLDivElement {
	if (!hiddenContainer) {
		hiddenContainer = document.createElement("div");
		hiddenContainer.style.position = "fixed";
		hiddenContainer.style.left = "-9999px";
		hiddenContainer.style.top = "-9999px";
		hiddenContainer.style.width = "100vw";
		hiddenContainer.style.height = "100vh";
		hiddenContainer.style.overflow = "hidden";
		hiddenContainer.style.pointerEvents = "none";
		document.body.appendChild(hiddenContainer);
	}
	return hiddenContainer;
}

export function createVscodeExtensionPanePersistenceId(paneId: string): string {
	return `pane:${paneId}`;
}

export function createVscodeExtensionSidebarPersistenceId(
	viewType: string,
): string {
	return `sidebar:${viewType}`;
}

export function getPersistentVscodeExtensionHost(
	hostId: string,
): PersistentVscodeExtensionHost | undefined {
	return hostRegistry.get(hostId);
}

export function setPersistentVscodeExtensionHost(
	hostId: string,
	host: PersistentVscodeExtensionHost,
): void {
	hostRegistry.set(hostId, host);
}

export function parkPersistentVscodeExtensionHost(hostId: string): void {
	const host = hostRegistry.get(hostId);
	if (!host) return;
	getHiddenContainer().appendChild(host.wrapper);
}

export function destroyPersistentVscodeExtensionHost(hostId: string): void {
	const host = hostRegistry.get(hostId);
	if (!host) return;
	host.wrapper.remove();
	hostRegistry.delete(hostId);
}
