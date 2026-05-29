import type { HostAgentConfig } from "@superset/host-service/settings";
import { useCallback, useMemo, useState } from "react";
import type { TerminalAgentBinding } from "renderer/hooks/host-service/useTerminalAgentBindings";

export type AgentSessionPlacement = "split-pane" | "new-tab";

export type AgentTarget =
	| { kind: "existing"; terminalId: string }
	| { kind: "new"; configId: string; placement: AgentSessionPlacement };

export interface DecodedSelection {
	kind: "existing" | "new";
	id: string;
}

export const EXISTING_PREFIX = "existing:";
export const NEW_PREFIX = "new:";

const LAST_NEW_AGENT_CONFIG_ID_KEY = "lastSelectedDiffCommentNewAgentConfigId";
const LAST_TERMINAL_ID_KEY = "lastSelectedDiffCommentTerminalId";
const LAST_PLACEMENT_KEY = "lastSelectedDiffCommentPlacement";
const DEFAULT_PLACEMENT: AgentSessionPlacement = "split-pane";

function readStorage(key: string): string | null {
	if (typeof window === "undefined") return null;
	return window.localStorage.getItem(key);
}

function writeStorage(key: string, value: string) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(key, value);
}

export function decodeSelection(value: string): DecodedSelection | null {
	if (value.startsWith(EXISTING_PREFIX)) {
		return { kind: "existing", id: value.slice(EXISTING_PREFIX.length) };
	}
	if (value.startsWith(NEW_PREFIX)) {
		return { kind: "new", id: value.slice(NEW_PREFIX.length) };
	}
	return null;
}

interface UseDiffCommentTargetArgs {
	sessions: TerminalAgentBinding[];
	configs: HostAgentConfig[];
}

interface UseDiffCommentTargetResult {
	value: string | null;
	placement: AgentSessionPlacement;
	resolved: AgentTarget | null;
	onValueChange: (next: string) => void;
	onPlacementChange: (next: string) => void;
}

export function useDiffCommentTarget({
	sessions,
	configs,
}: UseDiffCommentTargetArgs): UseDiffCommentTargetResult {
	const [override, setOverride] = useState<string | null>(null);
	const [placement, setPlacement] = useState<AgentSessionPlacement>(() => {
		const stored = readStorage(LAST_PLACEMENT_KEY);
		return stored === "new-tab" || stored === "split-pane"
			? stored
			: DEFAULT_PLACEMENT;
	});

	const computedDefault = useMemo<string | null>(() => {
		if (sessions.length > 0) {
			const stored = readStorage(LAST_TERMINAL_ID_KEY);
			const alive =
				stored && sessions.some((s) => s.terminalId === stored)
					? stored
					: sessions[0]?.terminalId;
			if (alive) return `${EXISTING_PREFIX}${alive}`;
		}
		if (configs.length === 0) return null;
		const storedConfigId = readStorage(LAST_NEW_AGENT_CONFIG_ID_KEY);
		const fromStorage =
			storedConfigId && configs.some((c) => c.id === storedConfigId)
				? storedConfigId
				: configs[0]?.id;
		return fromStorage ? `${NEW_PREFIX}${fromStorage}` : null;
	}, [sessions, configs]);

	const overrideIsValid = useMemo(() => {
		if (!override) return false;
		const decoded = decodeSelection(override);
		if (!decoded) return false;
		if (decoded.kind === "existing") {
			return sessions.some((s) => s.terminalId === decoded.id);
		}
		return configs.some((c) => c.id === decoded.id);
	}, [override, sessions, configs]);

	const value = overrideIsValid ? override : computedDefault;

	const resolved = useMemo<AgentTarget | null>(() => {
		if (!value) return null;
		const decoded = decodeSelection(value);
		if (!decoded) return null;
		if (decoded.kind === "existing") {
			return { kind: "existing", terminalId: decoded.id };
		}
		return { kind: "new", configId: decoded.id, placement };
	}, [value, placement]);

	const onValueChange = useCallback((next: string) => {
		setOverride(next);
		const decoded = decodeSelection(next);
		if (!decoded) return;
		writeStorage(
			decoded.kind === "existing"
				? LAST_TERMINAL_ID_KEY
				: LAST_NEW_AGENT_CONFIG_ID_KEY,
			decoded.id,
		);
	}, []);

	const onPlacementChange = useCallback((next: string) => {
		if (next !== "split-pane" && next !== "new-tab") return;
		setPlacement(next);
		writeStorage(LAST_PLACEMENT_KEY, next);
	}, []);

	return { value, placement, resolved, onValueChange, onPlacementChange };
}
