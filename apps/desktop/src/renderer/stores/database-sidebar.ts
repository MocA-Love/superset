import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { useShallow } from "zustand/shallow";

export interface SavedDatabaseConnection {
	id: string;
	label: string;
	group?: string;
	dialect: "sqlite" | "postgres";
	source?: "manual" | "workspace-config";
	databasePath?: string;
	connectionStringId?: string;
	/** @deprecated use connectionStringId instead */
	connectionString?: string;
	workspacePath?: string;
	workspaceDefinitionId?: string;
	host?: string;
	port?: number;
	databaseName?: string;
	ssl?: boolean;
	usernameHint?: string;
	createdAt: number;
	_pendingConnectionString?: string;
}

export interface SavedDatabaseQueryHistoryItem {
	id: string;
	connectionId: string;
	sql: string;
	executedAt: number;
}

type ConnectionInput =
	| {
			label: string;
			group?: string;
			source?: "manual";
			dialect: "sqlite";
			databasePath: string;
	  }
	| {
			label: string;
			group?: string;
			source: "workspace-config";
			dialect: "sqlite";
			databasePath: string;
			workspacePath: string;
			workspaceDefinitionId: string;
	  }
	| {
			label: string;
			group?: string;
			source?: "manual";
			dialect: "postgres";
			connectionStringId: string;
	  }
	| {
			label: string;
			group?: string;
			dialect: "postgres";
			source: "workspace-config";
			workspacePath: string;
			workspaceDefinitionId: string;
			host: string;
			port: number;
			databaseName: string;
			ssl: boolean;
			usernameHint?: string;
	  };

type ConnectionUpdateInput =
	| {
			id: string;
			label: string;
			group?: string;
			source?: "manual";
			dialect: "sqlite";
			databasePath: string;
	  }
	| {
			id: string;
			label: string;
			group?: string;
			source: "workspace-config";
			dialect: "sqlite";
			databasePath: string;
			workspacePath: string;
			workspaceDefinitionId: string;
	  }
	| {
			id: string;
			label: string;
			group?: string;
			source?: "manual";
			dialect: "postgres";
			connectionStringId: string;
			_pendingConnectionString?: undefined;
	  }
	| {
			id: string;
			label: string;
			group?: string;
			source: "workspace-config";
			dialect: "postgres";
			workspacePath: string;
			workspaceDefinitionId: string;
			host: string;
			port: number;
			databaseName: string;
			ssl: boolean;
			usernameHint?: string;
	  };

interface WorkspaceDatabaseState {
	connections: SavedDatabaseConnection[];
	queryHistory: SavedDatabaseQueryHistoryItem[];
	activeConnectionId: string | null;
}

const emptyWorkspaceState: WorkspaceDatabaseState = {
	connections: [],
	queryHistory: [],
	activeConnectionId: null,
};

interface DatabaseSidebarState {
	workspaces: Record<string, WorkspaceDatabaseState>;
	addConnection: (
		workspaceId: string,
		input: ConnectionInput,
	) => SavedDatabaseConnection;
	updateConnection: (
		workspaceId: string,
		input: ConnectionUpdateInput,
	) => SavedDatabaseConnection | null;
	removeConnection: (workspaceId: string, id: string) => void;
	setActiveConnectionId: (workspaceId: string, id: string | null) => void;
	addQueryHistoryItem: (
		workspaceId: string,
		input: {
			connectionId: string;
			sql: string;
		},
	) => SavedDatabaseQueryHistoryItem;
	removeQueryHistoryItem: (workspaceId: string, id: string) => void;
	clearQueryHistoryForConnection: (
		workspaceId: string,
		connectionId: string,
	) => void;
}

const UNASSIGNED_KEY = "_unassigned";

function getWorkspace(
	state: DatabaseSidebarState,
	workspaceId: string,
): WorkspaceDatabaseState {
	return state.workspaces[workspaceId] ?? emptyWorkspaceState;
}

function buildConnection(input: ConnectionInput): SavedDatabaseConnection {
	return {
		id: crypto.randomUUID(),
		label: input.label,
		group: input.group,
		dialect: input.dialect,
		source: input.source ?? "manual",
		databasePath: input.dialect === "sqlite" ? input.databasePath : undefined,
		connectionStringId:
			input.dialect === "postgres" && input.source !== "workspace-config"
				? input.connectionStringId
				: undefined,
		workspacePath:
			input.source === "workspace-config" &&
			(input.dialect === "sqlite" || input.dialect === "postgres")
				? input.workspacePath
				: undefined,
		workspaceDefinitionId:
			input.source === "workspace-config" &&
			(input.dialect === "sqlite" || input.dialect === "postgres")
				? input.workspaceDefinitionId
				: undefined,
		host:
			input.dialect === "postgres" && input.source === "workspace-config"
				? input.host
				: undefined,
		port:
			input.dialect === "postgres" && input.source === "workspace-config"
				? input.port
				: undefined,
		databaseName:
			input.dialect === "postgres" && input.source === "workspace-config"
				? input.databaseName
				: undefined,
		ssl:
			input.dialect === "postgres" && input.source === "workspace-config"
				? input.ssl
				: undefined,
		usernameHint:
			input.dialect === "postgres" && input.source === "workspace-config"
				? input.usernameHint
				: undefined,
		createdAt: Date.now(),
	};
}

export const useDatabaseSidebarStore = create<DatabaseSidebarState>()(
	devtools(
		persist(
			(set, get) => ({
				workspaces: {},

				addConnection: (workspaceId, input) => {
					const state = get();
					const ws = getWorkspace(state, workspaceId);
					const unassigned = getWorkspace(state, UNASSIGNED_KEY);
					const allConnections = [...ws.connections, ...unassigned.connections];
					const existingConnection = allConnections.find((connection) => {
						if (connection.dialect !== input.dialect) {
							return false;
						}

						if (input.dialect === "sqlite") {
							if (input.source === "workspace-config") {
								return (
									connection.source === "workspace-config" &&
									connection.workspacePath === input.workspacePath &&
									connection.workspaceDefinitionId ===
										input.workspaceDefinitionId
								);
							}

							return connection.databasePath === input.databasePath;
						}

						if (input.source === "workspace-config") {
							return (
								connection.source === "workspace-config" &&
								connection.workspacePath === input.workspacePath &&
								connection.workspaceDefinitionId === input.workspaceDefinitionId
							);
						}

						return connection.connectionStringId === input.connectionStringId;
					});
					if (existingConnection) {
						set((s) => ({
							workspaces: {
								...s.workspaces,
								[workspaceId]: {
									...getWorkspace(s, workspaceId),
									activeConnectionId: existingConnection.id,
								},
							},
						}));
						return existingConnection;
					}

					const connection = buildConnection(input);

					set((state) => {
						const current = getWorkspace(state, workspaceId);
						return {
							workspaces: {
								...state.workspaces,
								[workspaceId]: {
									...current,
									connections: [connection, ...current.connections],
									activeConnectionId: connection.id,
								},
							},
						};
					});

					return connection;
				},

				updateConnection: (workspaceId, input) => {
					const state = get();
					const ws = getWorkspace(state, workspaceId);
					const unassigned = getWorkspace(state, UNASSIGNED_KEY);
					const isInWorkspace = ws.connections.some((c) => c.id === input.id);
					const isInUnassigned =
						!isInWorkspace &&
						unassigned.connections.some((c) => c.id === input.id);
					const currentConnection = isInWorkspace
						? ws.connections.find((c) => c.id === input.id)
						: isInUnassigned
							? unassigned.connections.find((c) => c.id === input.id)
							: undefined;
					if (!currentConnection) {
						return null;
					}

					const updatedConnection: SavedDatabaseConnection = {
						...currentConnection,
						label: input.label,
						group: input.group,
						dialect: input.dialect,
						source: input.source ?? "manual",
						databasePath:
							input.dialect === "sqlite" ? input.databasePath : undefined,
						connectionStringId:
							input.dialect === "postgres" &&
							input.source !== "workspace-config"
								? input.connectionStringId
								: undefined,
						workspacePath:
							input.source === "workspace-config"
								? input.workspacePath
								: undefined,
						workspaceDefinitionId:
							input.source === "workspace-config"
								? input.workspaceDefinitionId
								: undefined,
						host:
							input.dialect === "postgres" &&
							input.source === "workspace-config"
								? input.host
								: undefined,
						port:
							input.dialect === "postgres" &&
							input.source === "workspace-config"
								? input.port
								: undefined,
						databaseName:
							input.dialect === "postgres" &&
							input.source === "workspace-config"
								? input.databaseName
								: undefined,
						ssl:
							input.dialect === "postgres" &&
							input.source === "workspace-config"
								? input.ssl
								: undefined,
						usernameHint:
							input.dialect === "postgres" &&
							input.source === "workspace-config"
								? input.usernameHint
								: undefined,
						_pendingConnectionString: undefined,
					};

					set((s) => {
						const updates: Record<string, WorkspaceDatabaseState> = {
							...s.workspaces,
						};
						if (isInUnassigned) {
							const ua = getWorkspace(s, UNASSIGNED_KEY);
							updates[UNASSIGNED_KEY] = {
								...ua,
								connections: ua.connections.map((c) =>
									c.id === input.id ? updatedConnection : c,
								),
							};
						} else {
							const current = getWorkspace(s, workspaceId);
							updates[workspaceId] = {
								...current,
								connections: current.connections.map((c) =>
									c.id === input.id ? updatedConnection : c,
								),
								activeConnectionId: input.id,
							};
						}
						return { workspaces: updates };
					});

					return updatedConnection;
				},

				removeConnection: (workspaceId, id) => {
					set((state) => {
						const updates: Record<string, WorkspaceDatabaseState> = {
							...state.workspaces,
						};

						// Remove from workspace-scoped bucket
						const current = getWorkspace(state, workspaceId);
						const nextConnections = current.connections.filter(
							(c) => c.id !== id,
						);
						updates[workspaceId] = {
							...current,
							connections: nextConnections,
							queryHistory: current.queryHistory.filter(
								(item) => item.connectionId !== id,
							),
							activeConnectionId:
								current.activeConnectionId === id
									? (nextConnections[0]?.id ?? null)
									: current.activeConnectionId,
						};

						// Also remove from _unassigned if present
						const ua = getWorkspace(state, UNASSIGNED_KEY);
						if (ua.connections.some((c) => c.id === id)) {
							updates[UNASSIGNED_KEY] = {
								...ua,
								connections: ua.connections.filter((c) => c.id !== id),
								queryHistory: ua.queryHistory.filter(
									(item) => item.connectionId !== id,
								),
								activeConnectionId:
									ua.activeConnectionId === id ? null : ua.activeConnectionId,
							};
						}

						return { workspaces: updates };
					});
				},

				setActiveConnectionId: (workspaceId, id) => {
					set((state) => ({
						workspaces: {
							...state.workspaces,
							[workspaceId]: {
								...getWorkspace(state, workspaceId),
								activeConnectionId: id,
							},
						},
					}));
				},

				addQueryHistoryItem: (workspaceId, { connectionId, sql }) => {
					const normalizedSql = sql.trim();
					const item: SavedDatabaseQueryHistoryItem = {
						id: crypto.randomUUID(),
						connectionId,
						sql: normalizedSql,
						executedAt: Date.now(),
					};

					set((state) => {
						const current = getWorkspace(state, workspaceId);
						const deduped = current.queryHistory.filter(
							(entry) =>
								!(
									entry.connectionId === connectionId &&
									entry.sql.trim() === normalizedSql
								),
						);
						const nextHistory = [item, ...deduped].slice(0, 100);
						return {
							workspaces: {
								...state.workspaces,
								[workspaceId]: {
									...current,
									queryHistory: nextHistory,
								},
							},
						};
					});

					return item;
				},

				removeQueryHistoryItem: (workspaceId, id) => {
					set((state) => {
						const updates: Record<string, WorkspaceDatabaseState> = {
							...state.workspaces,
						};
						const current = getWorkspace(state, workspaceId);
						updates[workspaceId] = {
							...current,
							queryHistory: current.queryHistory.filter(
								(item) => item.id !== id,
							),
						};
						const ua = getWorkspace(state, UNASSIGNED_KEY);
						if (ua.queryHistory.some((item) => item.id === id)) {
							updates[UNASSIGNED_KEY] = {
								...ua,
								queryHistory: ua.queryHistory.filter((item) => item.id !== id),
							};
						}
						return { workspaces: updates };
					});
				},

				clearQueryHistoryForConnection: (workspaceId, connectionId) => {
					set((state) => {
						const updates: Record<string, WorkspaceDatabaseState> = {
							...state.workspaces,
						};
						const current = getWorkspace(state, workspaceId);
						updates[workspaceId] = {
							...current,
							queryHistory: current.queryHistory.filter(
								(item) => item.connectionId !== connectionId,
							),
						};
						const ua = getWorkspace(state, UNASSIGNED_KEY);
						if (
							ua.queryHistory.some((item) => item.connectionId === connectionId)
						) {
							updates[UNASSIGNED_KEY] = {
								...ua,
								queryHistory: ua.queryHistory.filter(
									(item) => item.connectionId !== connectionId,
								),
							};
						}
						return { workspaces: updates };
					});
				},
			}),
			{
				name: "database-sidebar-store",
				version: 6,
				migrate: (persistedState, version) => {
					if (version < 6) {
						// v5 → v6: migrate flat state to per-workspace structure
						const old = persistedState as {
							connections?: Array<{
								id: string;
								label: string;
								group?: string;
								databasePath?: string;
								dialect?: "sqlite" | "postgres";
								source?: "manual" | "workspace-config";
								connectionString?: string;
								connectionStringId?: string;
								workspacePath?: string;
								workspaceDefinitionId?: string;
								host?: string;
								port?: number;
								databaseName?: string;
								ssl?: boolean;
								usernameHint?: string;
								createdAt: number;
								_pendingConnectionString?: string;
							}>;
							queryHistory?: SavedDatabaseQueryHistoryItem[];
							activeConnectionId?: string | null;
						};

						const migratedConnections = (old.connections ?? []).map(
							(connection) => {
								const base = {
									...connection,
									dialect: connection.dialect ?? ("sqlite" as const),
									source: connection.source ?? ("manual" as const),
								};
								if (base.connectionString && !base.connectionStringId) {
									const newId = crypto.randomUUID();
									return {
										...base,
										connectionStringId: newId,
										connectionString: undefined,
										_pendingConnectionString: base.connectionString,
									};
								}
								return base;
							},
						);

						// Put all existing data under a special "_unassigned" key.
						// They will be visible in all workspaces until the user
						// re-adds them to specific workspaces.
						return {
							workspaces: {
								[UNASSIGNED_KEY]: {
									connections: migratedConnections as SavedDatabaseConnection[],
									queryHistory: old.queryHistory ?? [],
									activeConnectionId: old.activeConnectionId ?? null,
								},
							},
						} as unknown as DatabaseSidebarState;
					}

					return persistedState as DatabaseSidebarState;
				},
			},
		),
		{ name: "DatabaseSidebarStore" },
	),
);

// ── Workspace-scoped selector hooks ──

const EMPTY_CONNECTIONS: SavedDatabaseConnection[] = [];
const EMPTY_HISTORY: SavedDatabaseQueryHistoryItem[] = [];

function selectConnections(
	state: DatabaseSidebarState,
	workspaceId: string | undefined,
): SavedDatabaseConnection[] {
	if (!workspaceId) return EMPTY_CONNECTIONS;
	const ws = state.workspaces[workspaceId];
	const unassigned = state.workspaces[UNASSIGNED_KEY];
	const wsConnections = ws?.connections ?? EMPTY_CONNECTIONS;
	const unassignedConnections = unassigned?.connections ?? EMPTY_CONNECTIONS;
	if (unassignedConnections.length === 0) return wsConnections;
	const ids = new Set(wsConnections.map((c) => c.id));
	return [
		...wsConnections,
		...unassignedConnections.filter((c) => !ids.has(c.id)),
	];
}

function selectQueryHistory(
	state: DatabaseSidebarState,
	workspaceId: string | undefined,
): SavedDatabaseQueryHistoryItem[] {
	if (!workspaceId) return EMPTY_HISTORY;
	const ws = state.workspaces[workspaceId];
	const unassigned = state.workspaces[UNASSIGNED_KEY];
	const wsHistory = ws?.queryHistory ?? EMPTY_HISTORY;
	const unassignedHistory = unassigned?.queryHistory ?? EMPTY_HISTORY;
	if (unassignedHistory.length === 0) return wsHistory;
	const ids = new Set(wsHistory.map((h) => h.id));
	return [...wsHistory, ...unassignedHistory.filter((h) => !ids.has(h.id))];
}

export function useDatabaseConnections(workspaceId: string | undefined) {
	return useDatabaseSidebarStore(
		useShallow((state) => selectConnections(state, workspaceId)),
	);
}

export function useDatabaseActiveConnectionId(workspaceId: string | undefined) {
	return useDatabaseSidebarStore((state) => {
		if (!workspaceId) return null;
		return (
			state.workspaces[workspaceId]?.activeConnectionId ??
			state.workspaces[UNASSIGNED_KEY]?.activeConnectionId ??
			null
		);
	});
}

export function useDatabaseQueryHistory(workspaceId: string | undefined) {
	return useDatabaseSidebarStore(
		useShallow((state) => selectQueryHistory(state, workspaceId)),
	);
}
