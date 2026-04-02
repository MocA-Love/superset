import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface SavedDatabaseConnection {
	id: string;
	label: string;
	group?: string;
	dialect: "sqlite" | "postgres";
	source?: "manual" | "workspace-config";
	databasePath?: string;
	connectionString?: string;
	workspacePath?: string;
	workspaceDefinitionId?: string;
	host?: string;
	port?: number;
	databaseName?: string;
	ssl?: boolean;
	usernameHint?: string;
	createdAt: number;
}

export interface SavedDatabaseQueryHistoryItem {
	id: string;
	connectionId: string;
	sql: string;
	executedAt: number;
}

interface DatabaseSidebarState {
	connections: SavedDatabaseConnection[];
	queryHistory: SavedDatabaseQueryHistoryItem[];
	activeConnectionId: string | null;
	addConnection: (
		input:
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
					connectionString: string;
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
			  },
	) => SavedDatabaseConnection;
	updateConnection: (
		input:
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
					connectionString: string;
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
			  },
	) => SavedDatabaseConnection | null;
	removeConnection: (id: string) => void;
	setActiveConnectionId: (id: string | null) => void;
	addQueryHistoryItem: (input: {
		connectionId: string;
		sql: string;
	}) => SavedDatabaseQueryHistoryItem;
	removeQueryHistoryItem: (id: string) => void;
	clearQueryHistoryForConnection: (connectionId: string) => void;
}

export const useDatabaseSidebarStore = create<DatabaseSidebarState>()(
	devtools(
		persist(
			(set, get) => ({
				connections: [],
				queryHistory: [],
				activeConnectionId: null,

				addConnection: (input) => {
					const existingConnection = get().connections.find((connection) => {
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

						return connection.connectionString === input.connectionString;
					});
					if (existingConnection) {
						set({ activeConnectionId: existingConnection.id });
						return existingConnection;
					}

					const connection: SavedDatabaseConnection = {
						id: crypto.randomUUID(),
						label: input.label,
						group: input.group,
						dialect: input.dialect,
						source: input.source ?? "manual",
						databasePath:
							input.dialect === "sqlite" ? input.databasePath : undefined,
						connectionString:
							input.dialect === "postgres" &&
							input.source !== "workspace-config"
								? input.connectionString
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
						createdAt: Date.now(),
					};

					set((state) => ({
						connections: [connection, ...state.connections],
						activeConnectionId: connection.id,
					}));

					return connection;
				},

				updateConnection: (input) => {
					const currentConnection = get().connections.find(
						(connection) => connection.id === input.id,
					);
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
						connectionString:
							input.dialect === "postgres" &&
							input.source !== "workspace-config"
								? input.connectionString
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
					};

					set((state) => ({
						connections: state.connections.map((connection) =>
							connection.id === input.id ? updatedConnection : connection,
						),
						activeConnectionId: input.id,
					}));

					return updatedConnection;
				},

				removeConnection: (id) => {
					set((state) => {
						const nextConnections = state.connections.filter(
							(connection) => connection.id !== id,
						);
						return {
							connections: nextConnections,
							queryHistory: state.queryHistory.filter(
								(item) => item.connectionId !== id,
							),
							activeConnectionId:
								state.activeConnectionId === id
									? (nextConnections[0]?.id ?? null)
									: state.activeConnectionId,
						};
					});
				},

				setActiveConnectionId: (id) => {
					set({ activeConnectionId: id });
				},

				addQueryHistoryItem: ({ connectionId, sql }) => {
					const normalizedSql = sql.trim();
					const item: SavedDatabaseQueryHistoryItem = {
						id: crypto.randomUUID(),
						connectionId,
						sql: normalizedSql,
						executedAt: Date.now(),
					};

					set((state) => {
						const deduped = state.queryHistory.filter(
							(entry) =>
								!(
									entry.connectionId === connectionId &&
									entry.sql.trim() === normalizedSql
								),
						);
						const nextHistory = [item, ...deduped].slice(0, 100);
						return {
							queryHistory: nextHistory,
						};
					});

					return item;
				},

				removeQueryHistoryItem: (id) => {
					set((state) => ({
						queryHistory: state.queryHistory.filter((item) => item.id !== id),
					}));
				},

				clearQueryHistoryForConnection: (connectionId) => {
					set((state) => ({
						queryHistory: state.queryHistory.filter(
							(item) => item.connectionId !== connectionId,
						),
					}));
				},
			}),
			{
				name: "database-sidebar-store",
				version: 4,
				migrate: (persistedState) => {
					const state = persistedState as {
						connections?: Array<{
							id: string;
							label: string;
							group?: string;
							databasePath?: string;
							dialect?: "sqlite" | "postgres";
							source?: "manual" | "workspace-config";
							connectionString?: string;
							workspacePath?: string;
							workspaceDefinitionId?: string;
							host?: string;
							port?: number;
							databaseName?: string;
							ssl?: boolean;
							usernameHint?: string;
							createdAt: number;
						}>;
						queryHistory?: SavedDatabaseQueryHistoryItem[];
						activeConnectionId?: string | null;
					};

					return {
						connections: (state.connections ?? []).map((connection) => ({
							...connection,
							dialect: connection.dialect ?? "sqlite",
							source: connection.source ?? "manual",
						})),
						queryHistory: state.queryHistory ?? [],
						activeConnectionId: state.activeConnectionId ?? null,
					} as DatabaseSidebarState;
				},
			},
		),
		{ name: "DatabaseSidebarStore" },
	),
);
