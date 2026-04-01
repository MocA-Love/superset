import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export interface SavedDatabaseConnection {
	id: string;
	label: string;
	group?: string;
	dialect: "sqlite" | "postgres";
	databasePath?: string;
	connectionString?: string;
	createdAt: number;
}

interface DatabaseSidebarState {
	connections: SavedDatabaseConnection[];
	activeConnectionId: string | null;
	addConnection: (
		input:
			| {
					label: string;
					group?: string;
					dialect: "sqlite";
					databasePath: string;
			  }
			| {
					label: string;
					group?: string;
					dialect: "postgres";
					connectionString: string;
			  },
	) => SavedDatabaseConnection;
	updateConnection: (
		input:
			| {
					id: string;
					label: string;
					group?: string;
					dialect: "sqlite";
					databasePath: string;
			  }
			| {
					id: string;
					label: string;
					group?: string;
					dialect: "postgres";
					connectionString: string;
			  },
	) => SavedDatabaseConnection | null;
	removeConnection: (id: string) => void;
	setActiveConnectionId: (id: string | null) => void;
}

export const useDatabaseSidebarStore = create<DatabaseSidebarState>()(
	devtools(
		persist(
			(set, get) => ({
				connections: [],
				activeConnectionId: null,

				addConnection: (input) => {
					const existingConnection = get().connections.find((connection) => {
						if (connection.dialect !== input.dialect) {
							return false;
						}

						if (input.dialect === "sqlite") {
							return connection.databasePath === input.databasePath;
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
						databasePath:
							input.dialect === "sqlite" ? input.databasePath : undefined,
						connectionString:
							input.dialect === "postgres" ? input.connectionString : undefined,
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
						databasePath:
							input.dialect === "sqlite" ? input.databasePath : undefined,
						connectionString:
							input.dialect === "postgres" ? input.connectionString : undefined,
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
			}),
			{
				name: "database-sidebar-store",
				version: 2,
				migrate: (persistedState) => {
					const state = persistedState as {
						connections?: Array<{
							id: string;
							label: string;
							group?: string;
							databasePath?: string;
							dialect?: "sqlite" | "postgres";
							connectionString?: string;
							createdAt: number;
						}>;
						activeConnectionId?: string | null;
					};

					return {
						connections: (state.connections ?? []).map((connection) => ({
							...connection,
							dialect: connection.dialect ?? "sqlite",
						})),
						activeConnectionId: state.activeConnectionId ?? null,
					} as DatabaseSidebarState;
				},
			},
		),
		{ name: "DatabaseSidebarStore" },
	),
);
