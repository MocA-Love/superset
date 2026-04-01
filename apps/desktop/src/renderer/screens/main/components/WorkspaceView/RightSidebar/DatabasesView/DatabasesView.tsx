import { Alert, AlertDescription, AlertTitle } from "@superset/ui/alert";
import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@superset/ui/empty";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@superset/ui/resizable";
import { Switch } from "@superset/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@superset/ui/table";
import { Textarea } from "@superset/ui/textarea";
import { cn } from "@superset/ui/utils";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	LuChevronDown,
	LuChevronRight,
	LuCopy,
	LuDatabase,
	LuEraser,
	LuExternalLink,
	LuEye,
	LuEyeOff,
	LuPencil,
	LuPlay,
	LuPlus,
	LuRefreshCw,
	LuTable2,
	LuTrash2,
} from "react-icons/lu";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import {
	type SavedDatabaseConnection,
	useDatabaseSidebarStore,
} from "renderer/stores/database-sidebar";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";

const SQLITE_ROW_ID_COLUMN = "__superset_rowid";
const POSTGRES_ROW_ID_COLUMN = "__superset_ctid";

const SQLITE_DEFAULT_SQL = [
	"SELECT name",
	"FROM sqlite_master",
	"WHERE type = 'table'",
	"ORDER BY name;",
].join("\n");

const POSTGRES_DEFAULT_SQL = [
	"SELECT table_schema, table_name",
	"FROM information_schema.tables",
	"WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
	"ORDER BY table_schema, table_name",
	"LIMIT 50;",
].join("\n");

const TABLE_PREVIEW_PAGE_SIZE = 15;

type ConnectionDialect = "sqlite" | "postgres";

interface QueryResult {
	columns: string[];
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	truncated: boolean;
	elapsedMs: number;
	command?: string;
	lastInsertRowid?: string | number;
}

interface EditableCellState {
	row: Record<string, unknown>;
	column: string;
	value: unknown;
}

interface RowDraftValue {
	value: string;
	isNull: boolean;
}

interface ContextCellState {
	row: Record<string, unknown>;
	column: string;
	display: string;
	title: string;
}

interface PendingEditRequest {
	row: Record<string, unknown>;
	column?: string;
}

function isAbsoluteFilesystemPath(inputPath: string): boolean {
	return inputPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(inputPath);
}

function resolveSQLiteDatabasePath(
	rawPath: string,
	worktreePath?: string,
): string | null {
	const trimmedPath = rawPath.trim();
	if (!trimmedPath) return null;
	if (isAbsoluteFilesystemPath(trimmedPath)) return trimmedPath;
	if (!worktreePath) return null;
	return toAbsoluteWorkspacePath(worktreePath, trimmedPath);
}

function guessConnectionLabel(databasePath: string): string {
	return databasePath.split(/[/\\]/).pop() ?? databasePath;
}

function guessPostgresLabel(connectionString: string): string {
	try {
		const url = new URL(connectionString);
		const databaseName = url.pathname.replace(/^\//, "");
		return databaseName ? `${url.hostname}/${databaseName}` : url.hostname;
	} catch {
		return "PostgreSQL";
	}
}

function buildPostgresConnectionString(input: {
	host: string;
	port: string;
	username: string;
	password: string;
	database?: string;
	ssl: boolean;
}): string {
	const auth =
		input.password.trim().length > 0
			? `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}`
			: encodeURIComponent(input.username);
	const query = input.ssl ? "?sslmode=require" : "";
	const databaseName = input.database?.trim() || "postgres";

	return `postgres://${auth}@${input.host}:${input.port}/${databaseName}${query}`;
}

function parsePostgresConnectionString(connectionString: string): {
	host: string;
	port: string;
	username: string;
	password: string;
	database: string;
	ssl: boolean;
} | null {
	try {
		const url = new URL(connectionString);
		return {
			host: url.hostname,
			port: url.port || "5432",
			username: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
			database: url.pathname.replace(/^\//, "") || "postgres",
			ssl: url.searchParams.get("sslmode") === "require",
		};
	} catch {
		return null;
	}
}

function formatCellValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function quoteSqlIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function toSqlLiteral(value: unknown, dialect: ConnectionDialect): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : `'${String(value)}'`;
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "boolean") {
		if (dialect === "sqlite") {
			return value ? "1" : "0";
		}
		return value ? "TRUE" : "FALSE";
	}
	if (typeof value === "string") {
		return `'${value.replaceAll("'", "''")}'`;
	}
	if (value instanceof Date) {
		return `'${value.toISOString().replaceAll("'", "''")}'`;
	}
	return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
}

function buildSqliteRowSelector(row: Record<string, unknown>): string {
	const rowId = row[SQLITE_ROW_ID_COLUMN];
	if (rowId === undefined) {
		throw new Error("Missing SQLite row identifier.");
	}
	return `rowid = ${toSqlLiteral(rowId, "sqlite")}`;
}

function buildPostgresRowSelector(row: Record<string, unknown>): string {
	const ctid = row[POSTGRES_ROW_ID_COLUMN];
	if (ctid === undefined) {
		throw new Error("Missing Postgres row identifier.");
	}
	return `ctid = ${toSqlLiteral(ctid, "postgres")}`;
}

function normalizeDraftValue(
	value: string,
	originalValue: unknown,
): string | number | boolean | null {
	if (originalValue === null || originalValue === undefined) {
		return value;
	}
	if (typeof originalValue === "number") {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? value : parsed;
	}
	if (typeof originalValue === "boolean") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "t", "yes"].includes(normalized)) return true;
		if (["false", "0", "f", "no"].includes(normalized)) return false;
		return value;
	}
	return value;
}

const PreviewTableCellValue = memo(function PreviewTableCellValue({
	value,
	onContextMenu,
}: {
	value: unknown;
	onContextMenu: () => void;
}) {
	const formattedValue = useMemo(() => formatCellValue(value), [value]);

	return (
		<button
			type="button"
			className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-left"
			title={formattedValue}
			onContextMenu={onContextMenu}
		>
			{formattedValue}
		</button>
	);
});

function getConnectionSubtitle(connection: SavedDatabaseConnection): string {
	return connection.dialect === "sqlite"
		? (connection.databasePath ?? "")
		: (connection.connectionString ?? "");
}

function getTableKey(table: { schema: string | null; name: string }): string {
	return `${table.schema ?? "main"}.${table.name}`;
}

function getSchemaKey(table: { schema: string | null }): string {
	return table.schema ?? "main";
}

function ConnectionItem({
	connection,
	isActive,
	onOpen,
	onEdit,
	onSelect,
	onRemove,
}: {
	connection: SavedDatabaseConnection;
	isActive: boolean;
	onOpen?: () => void;
	onEdit?: () => void;
	onSelect: () => void;
	onRemove?: () => void;
}) {
	return (
		<div
			className={cn(
				"group flex items-start gap-2 rounded-md border p-2 transition-colors",
				isActive ? "border-primary bg-accent/40" : "hover:bg-muted/40",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				className="min-w-0 flex-1 text-left"
			>
				<div className="flex items-center gap-2">
					<LuDatabase className="text-muted-foreground size-3.5 shrink-0" />
					<span className="truncate text-sm font-medium">
						{connection.label}
					</span>
					<Badge variant="outline">{connection.dialect}</Badge>
					{connection.group ? (
						<Badge variant="secondary">{connection.group}</Badge>
					) : null}
				</div>
				<p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
					{getConnectionSubtitle(connection)}
				</p>
			</button>
			{onOpen ? (
				<Button
					variant="ghost"
					size="icon"
					type="button"
					className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
					onClick={onOpen}
				>
					<LuExternalLink className="size-3.5" />
				</Button>
			) : null}
			{onEdit ? (
				<Button
					variant="ghost"
					size="icon"
					type="button"
					className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
					onClick={onEdit}
				>
					<LuPencil className="size-3.5" />
				</Button>
			) : null}
			{onRemove ? (
				<Button
					variant="ghost"
					size="icon"
					type="button"
					className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
					onClick={onRemove}
				>
					<LuTrash2 className="size-3.5" />
				</Button>
			) : null}
		</div>
	);
}

interface DatabasesViewProps {
	mode?: "sidebar" | "pane";
	onOpenExplorer?: (connectionId: string) => void;
	selectedConnectionId?: string | null;
	onSelectConnectionId?: (connectionId: string | null) => void;
	workspaceId?: string;
}

export function DatabasesView({
	mode = "sidebar",
	onOpenExplorer,
	selectedConnectionId,
	onSelectConnectionId,
	workspaceId: workspaceIdProp,
}: DatabasesViewProps) {
	const workspaceIdFromContext = useWorkspaceId();
	const workspaceId = workspaceIdProp ?? workspaceIdFromContext;
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const worktreePath = workspace?.worktreePath;
	const isSidebarMode = mode === "sidebar";
	const isPaneMode = mode === "pane";
	const { copyToClipboard } = useCopyToClipboard();

	const connections = useDatabaseSidebarStore((state) => state.connections);
	const sidebarSelectedConnectionId = useDatabaseSidebarStore(
		(state) => state.activeConnectionId,
	);
	const addConnection = useDatabaseSidebarStore((state) => state.addConnection);
	const updateConnection = useDatabaseSidebarStore(
		(state) => state.updateConnection,
	);
	const removeConnection = useDatabaseSidebarStore(
		(state) => state.removeConnection,
	);
	const setActiveConnectionId = useDatabaseSidebarStore(
		(state) => state.setActiveConnectionId,
	);
	const resolvedSelectedConnectionId =
		selectedConnectionId ?? sidebarSelectedConnectionId;
	const handleSelectConnectionId =
		onSelectConnectionId ?? setActiveConnectionId;

	const activeConnection =
		connections.find(
			(connection) => connection.id === resolvedSelectedConnectionId,
		) ?? null;

	const [connectionType, setConnectionType] =
		useState<ConnectionDialect>("postgres");
	const [isAddConnectionOpen, setIsAddConnectionOpen] = useState(false);
	const [editingConnectionId, setEditingConnectionId] = useState<string | null>(
		null,
	);
	const [labelInput, setLabelInput] = useState("");
	const [groupInput, setGroupInput] = useState("");
	const [pathInput, setPathInput] = useState("");
	const [useConnectionString, setUseConnectionString] = useState(false);
	const [postgresHost, setPostgresHost] = useState("127.0.0.1");
	const [postgresPort, setPostgresPort] = useState("5432");
	const [postgresUsername, setPostgresUsername] = useState("postgres");
	const [postgresPassword, setPostgresPassword] = useState("");
	const [postgresDatabase, setPostgresDatabase] = useState("");
	const [postgresSsl, setPostgresSsl] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
	const [tablePreviewPage, setTablePreviewPage] = useState(0);
	const [expandedSchemaKeys, setExpandedSchemaKeys] = useState<
		Record<string, boolean>
	>({});
	const [sql, setSql] = useState(POSTGRES_DEFAULT_SQL);
	const [formError, setFormError] = useState<string | null>(null);
	const [queryError, setQueryError] = useState<string | null>(null);
	const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
	const [isSqlDialogOpen, setIsSqlDialogOpen] = useState(false);
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isCellContextMenuOpen, setIsCellContextMenuOpen] = useState(false);
	const [contextCell, setContextCell] = useState<ContextCellState | null>(null);
	const [pendingEditRequest, setPendingEditRequest] =
		useState<PendingEditRequest | null>(null);
	const [editingCell, setEditingCell] = useState<EditableCellState | null>(
		null,
	);
	const [rowDraft, setRowDraft] = useState<Record<string, RowDraftValue>>({});

	const labelInputRef = useRef<HTMLInputElement>(null);
	const groupInputRef = useRef<HTMLInputElement>(null);
	const pathInputRef = useRef<HTMLInputElement>(null);
	const postgresHostRef = useRef<HTMLInputElement>(null);
	const postgresPortRef = useRef<HTMLInputElement>(null);
	const postgresUsernameRef = useRef<HTMLInputElement>(null);
	const postgresPasswordRef = useRef<HTMLInputElement>(null);
	const postgresDatabaseRef = useRef<HTMLInputElement>(null);
	const previousActiveConnectionIdRef = useRef<string | null>(null);
	const editDialogOpenedAtRef = useRef(0);

	const resetConnectionForm = () => {
		setEditingConnectionId(null);
		setLabelInput("");
		setGroupInput("");
		setPathInput("");
		setUseConnectionString(false);
		setPostgresHost("127.0.0.1");
		setPostgresPort("5432");
		setPostgresUsername("postgres");
		setPostgresPassword("");
		setPostgresDatabase("");
		setPostgresSsl(false);
		setShowPassword(false);
		setFormError(null);
	};

	const populateConnectionForm = (connection: SavedDatabaseConnection) => {
		setEditingConnectionId(connection.id);
		setConnectionType(connection.dialect);
		setLabelInput(connection.label);
		setGroupInput(connection.group ?? "");
		setFormError(null);
		setShowPassword(false);

		if (connection.dialect === "sqlite") {
			setPathInput(connection.databasePath ?? "");
			setUseConnectionString(false);
			setPostgresHost("127.0.0.1");
			setPostgresPort("5432");
			setPostgresUsername("postgres");
			setPostgresPassword("");
			setPostgresDatabase("");
			setPostgresSsl(false);
			return;
		}

		const parsed = parsePostgresConnectionString(
			connection.connectionString ?? "",
		);
		if (parsed) {
			setUseConnectionString(false);
			setPathInput("");
			setPostgresHost(parsed.host);
			setPostgresPort(parsed.port);
			setPostgresUsername(parsed.username);
			setPostgresPassword(parsed.password);
			setPostgresDatabase(parsed.database);
			setPostgresSsl(parsed.ssl);
			return;
		}

		setUseConnectionString(true);
		setPathInput(connection.connectionString ?? "");
		setPostgresHost("127.0.0.1");
		setPostgresPort("5432");
		setPostgresUsername("postgres");
		setPostgresPassword("");
		setPostgresDatabase("");
		setPostgresSsl(false);
	};

	useEffect(() => {
		if (!resolvedSelectedConnectionId && connections.length > 0) {
			handleSelectConnectionId(connections[0]?.id ?? null);
		}
	}, [resolvedSelectedConnectionId, connections, handleSelectConnectionId]);

	useEffect(() => {
		if (
			previousActiveConnectionIdRef.current === resolvedSelectedConnectionId
		) {
			return;
		}

		console.log("[DatabasesView] active connection changed", {
			connectionId: resolvedSelectedConnectionId,
		});
		previousActiveConnectionIdRef.current = resolvedSelectedConnectionId;
		setQueryError(null);
		setQueryResult(null);
		setSelectedTableKey(null);
		setTablePreviewPage(0);
	}, [resolvedSelectedConnectionId]);

	useEffect(() => {
		setSql(
			connectionType === "sqlite" ? SQLITE_DEFAULT_SQL : POSTGRES_DEFAULT_SQL,
		);
	}, [connectionType]);

	const discoverQuery = electronTrpc.databases.discoverSqliteFiles.useQuery(
		{ worktreePath: worktreePath ?? "", limit: 25 },
		{ enabled: Boolean(worktreePath) },
	);

	const inspectSqliteQuery = electronTrpc.databases.inspectSqlite.useQuery(
		{ databasePath: activeConnection?.databasePath ?? "" },
		{
			enabled:
				activeConnection?.dialect === "sqlite" &&
				Boolean(activeConnection.databasePath),
		},
	);

	const inspectPostgresQuery = electronTrpc.databases.inspectPostgres.useQuery(
		{ connectionString: activeConnection?.connectionString ?? "" },
		{
			enabled:
				activeConnection?.dialect === "postgres" &&
				Boolean(activeConnection.connectionString),
		},
	);

	const activeSchemaQuery =
		activeConnection?.dialect === "postgres"
			? inspectPostgresQuery
			: inspectSqliteQuery;
	const activeTables = activeSchemaQuery.data?.tables ?? [];
	const selectedTable =
		activeTables.find((table) => getTableKey(table) === selectedTableKey) ??
		null;
	const tablesBySchema = useMemo(() => {
		const grouped = new Map<string, Array<(typeof activeTables)[number]>>();

		for (const table of activeTables) {
			const schemaKey = getSchemaKey(table);
			const currentTables = grouped.get(schemaKey) ?? [];
			currentTables.push(table);
			grouped.set(schemaKey, currentTables);
		}

		return Array.from(grouped.entries()).map(([schemaKey, tables]) => ({
			schemaKey,
			label: schemaKey,
			tables,
		}));
	}, [activeTables]);

	useEffect(() => {
		if (!activeTables.length) {
			if (selectedTableKey !== null) {
				setSelectedTableKey(null);
			}
			return;
		}

		if (
			selectedTableKey &&
			!activeTables.some((table) => getTableKey(table) === selectedTableKey)
		) {
			setSelectedTableKey(null);
		}
	}, [activeTables, selectedTableKey]);

	useEffect(() => {
		setExpandedSchemaKeys((current) => {
			if (!tablesBySchema.length) {
				return Object.keys(current).length === 0 ? current : {};
			}

			let changed = false;
			const nextState = { ...current };
			for (const group of tablesBySchema) {
				if (nextState[group.schemaKey] === undefined) {
					nextState[group.schemaKey] = false;
					changed = true;
				}
			}

			return changed ? nextState : current;
		});
	}, [tablesBySchema]);

	const previewSqliteQuery = electronTrpc.databases.previewSqliteTable.useQuery(
		{
			databasePath: activeConnection?.databasePath ?? "",
			tableName: selectedTable?.name ?? "",
			limit: TABLE_PREVIEW_PAGE_SIZE,
			offset: tablePreviewPage * TABLE_PREVIEW_PAGE_SIZE,
		},
		{
			enabled:
				activeConnection?.dialect === "sqlite" &&
				Boolean(activeConnection.databasePath) &&
				Boolean(selectedTable?.name),
		},
	);

	const previewPostgresQuery =
		electronTrpc.databases.previewPostgresTable.useQuery(
			{
				connectionString: activeConnection?.connectionString ?? "",
				schema: selectedTable?.schema ?? "public",
				tableName: selectedTable?.name ?? "",
				limit: TABLE_PREVIEW_PAGE_SIZE,
				offset: tablePreviewPage * TABLE_PREVIEW_PAGE_SIZE,
			},
			{
				enabled:
					activeConnection?.dialect === "postgres" &&
					Boolean(activeConnection.connectionString) &&
					Boolean(selectedTable?.schema) &&
					Boolean(selectedTable?.name),
			},
		);

	const executeSQLiteMutation =
		electronTrpc.databases.executeSqlite.useMutation({
			onSuccess: (result) => {
				setQueryError(null);
				setQueryResult(result);
			},
			onError: (error) => {
				setQueryResult(null);
				setQueryError(error.message);
			},
		});

	const executePostgresMutation =
		electronTrpc.databases.executePostgres.useMutation({
			onSuccess: (result) => {
				setQueryError(null);
				setQueryResult(result);
			},
			onError: (error) => {
				setQueryResult(null);
				setQueryError(error.message);
			},
		});

	const discoveredFiles = useMemo(() => {
		const connectedPaths = new Set(
			connections
				.filter((connection) => connection.dialect === "sqlite")
				.map((connection) => connection.databasePath)
				.filter((value): value is string => Boolean(value)),
		);

		return (discoverQuery.data?.files ?? []).filter(
			(file) => !connectedPaths.has(file.absolutePath),
		);
	}, [connections, discoverQuery.data?.files]);
	const activePreviewQuery =
		activeConnection?.dialect === "postgres"
			? previewPostgresQuery
			: previewSqliteQuery;
	const isQueryRunning =
		executeSQLiteMutation.isPending || executePostgresMutation.isPending;

	const visiblePreviewColumns = activePreviewQuery.data?.columns ?? [];
	const selectedTableLabel = selectedTable
		? selectedTable.schema
			? `${selectedTable.schema}.${selectedTable.name}`
			: selectedTable.name
		: null;
	const previewRows = activePreviewQuery.data?.rows ?? [];

	useEffect(() => {
		if (!activeConnection || !selectedTable) {
			return;
		}

		console.log("[DatabasesView] preview query state", {
			dialect: activeConnection.dialect,
			connectionId: activeConnection.id,
			table: selectedTableLabel,
			page: tablePreviewPage,
			isLoading: activePreviewQuery.isLoading,
			isFetching: activePreviewQuery.isFetching,
			hasData: Boolean(activePreviewQuery.data),
			hasError: Boolean(activePreviewQuery.error),
			rowCount: previewRows.length,
			columnCount: activePreviewQuery.data?.columns.length ?? 0,
		});
	}, [
		activeConnection,
		selectedTable,
		selectedTableLabel,
		tablePreviewPage,
		activePreviewQuery.isLoading,
		activePreviewQuery.isFetching,
		activePreviewQuery.data,
		activePreviewQuery.error,
		previewRows.length,
	]);

	useEffect(() => {
		if (!selectedTableLabel) {
			setContextCell(null);
			return;
		}

		console.log("[DatabasesView] render table section", {
			table: selectedTableLabel,
			rowCount: previewRows.length,
			columnCount: visiblePreviewColumns.length,
			isLoading: activePreviewQuery.isLoading,
			isFetching: activePreviewQuery.isFetching,
		});
	}, [
		selectedTableLabel,
		previewRows.length,
		visiblePreviewColumns.length,
		activePreviewQuery.isLoading,
		activePreviewQuery.isFetching,
	]);

	const runSqlStatement = async (nextSql: string) => {
		if (!activeConnection) {
			throw new Error("Select a database connection first.");
		}

		if (
			activeConnection.dialect === "sqlite" &&
			activeConnection.databasePath
		) {
			return await executeSQLiteMutation.mutateAsync({
				databasePath: activeConnection.databasePath,
				sql: nextSql,
				limit: 200,
			});
		}

		if (
			activeConnection.dialect === "postgres" &&
			activeConnection.connectionString
		) {
			return await executePostgresMutation.mutateAsync({
				connectionString: activeConnection.connectionString,
				sql: nextSql,
				limit: 200,
			});
		}

		throw new Error(
			"The selected connection is missing its connection details.",
		);
	};

	const buildUpdateStatement = ({
		row,
		updates,
	}: {
		row: Record<string, unknown>;
		updates: Record<string, unknown>;
	}) => {
		if (!selectedTable || !activeConnection) {
			throw new Error("Select a table first.");
		}

		const assignments = Object.entries(updates).map(
			([column, value]) =>
				`${quoteSqlIdentifier(column)} = ${toSqlLiteral(
					value,
					activeConnection.dialect,
				)}`,
		);
		if (!assignments.length) {
			throw new Error("No changes to save.");
		}

		if (activeConnection.dialect === "sqlite") {
			return `UPDATE ${quoteSqlIdentifier(selectedTable.name)} SET ${assignments.join(", ")} WHERE ${buildSqliteRowSelector(row)}`;
		}

		return `UPDATE ${quoteSqlIdentifier(selectedTable.schema ?? "public")}.${quoteSqlIdentifier(selectedTable.name)} SET ${assignments.join(", ")} WHERE ${buildPostgresRowSelector(row)}`;
	};

	const applyRowUpdate = async ({
		row,
		updates,
	}: {
		row: Record<string, unknown>;
		updates: Record<string, unknown>;
	}) => {
		await runSqlStatement(buildUpdateStatement({ row, updates }));
		await activePreviewQuery.refetch();
	};

	const handleAddConnection = () => {
		setFormError(null);

		const nextLabel = labelInputRef.current?.value ?? labelInput;
		const nextGroup = groupInputRef.current?.value ?? groupInput;

		if (connectionType === "sqlite") {
			const nextPath = pathInputRef.current?.value ?? pathInput;
			const resolvedPath = resolveSQLiteDatabasePath(nextPath, worktreePath);
			if (!resolvedPath) {
				setFormError(
					worktreePath
						? "Database path is required."
						: "Use an absolute database path when no workspace is available.",
				);
				return;
			}

			const nextConnection = {
				label: nextLabel.trim() || guessConnectionLabel(resolvedPath),
				group: nextGroup.trim() || undefined,
				dialect: "sqlite" as const,
				databasePath: resolvedPath,
			};

			if (editingConnectionId) {
				updateConnection({
					id: editingConnectionId,
					...nextConnection,
				});
			} else {
				addConnection(nextConnection);
			}
		} else {
			const nextPath = pathInputRef.current?.value ?? pathInput;
			const nextHost = postgresHostRef.current?.value ?? postgresHost;
			const nextPort = postgresPortRef.current?.value ?? postgresPort;
			const nextUsername =
				postgresUsernameRef.current?.value ?? postgresUsername;
			const nextPassword =
				postgresPasswordRef.current?.value ?? postgresPassword;
			const nextDatabase =
				postgresDatabaseRef.current?.value ?? postgresDatabase;

			const connectionString = useConnectionString
				? nextPath.trim()
				: buildPostgresConnectionString({
						host: nextHost.trim(),
						port: nextPort.trim() || "5432",
						username: nextUsername.trim(),
						password: nextPassword,
						database: nextDatabase.trim() || "postgres",
						ssl: postgresSsl,
					});

			if (!connectionString) {
				setFormError("Postgres connection string is required.");
				return;
			}

			if (!useConnectionString && (!nextHost.trim() || !nextUsername.trim())) {
				setFormError("Host and username are required.");
				return;
			}

			const nextConnection = {
				label: nextLabel.trim() || guessPostgresLabel(connectionString),
				group: nextGroup.trim() || undefined,
				dialect: "postgres" as const,
				connectionString,
			};

			if (editingConnectionId) {
				updateConnection({
					id: editingConnectionId,
					...nextConnection,
				});
			} else {
				addConnection(nextConnection);
			}
		}

		resetConnectionForm();
		setIsAddConnectionOpen(false);
	};

	const handleAttachDiscoveredFile = (absolutePath: string) => {
		addConnection({
			label: guessConnectionLabel(absolutePath),
			group: groupInput.trim() || undefined,
			dialect: "sqlite",
			databasePath: absolutePath,
		});
	};

	const handleRunQuery = async () => {
		console.log("[DatabasesView] run SQL", {
			dialect: activeConnection?.dialect,
			connectionId: activeConnection?.id,
			sqlPreview: sql.slice(0, 200),
		});
		try {
			await runSqlStatement(sql);
		} catch (error) {
			setQueryResult(null);
			setQueryError(
				error instanceof Error ? error.message : "Failed to execute SQL.",
			);
		}
	};

	const handleOpenEditDialog = useCallback(
		(row: Record<string, unknown>, initialColumn?: string) => {
			console.log("[DatabasesView] open edit dialog", {
				table: selectedTableLabel,
				column: initialColumn,
			});
			const nextDraft = Object.fromEntries(
				visiblePreviewColumns.map((column) => [
					column,
					{
						value: formatCellValue(row[column]),
						isNull: row[column] === null,
					},
				]),
			) as Record<string, RowDraftValue>;

			if (initialColumn && nextDraft[initialColumn]) {
				nextDraft[initialColumn] = {
					value: formatCellValue(row[initialColumn]),
					isNull: row[initialColumn] === null,
				};
			}

			setRowDraft(nextDraft);
			setEditingCell({
				row,
				column: initialColumn ?? visiblePreviewColumns[0] ?? "",
				value: initialColumn ? row[initialColumn] : null,
			});
			editDialogOpenedAtRef.current = Date.now();
			setIsEditDialogOpen(true);
		},
		[selectedTableLabel, visiblePreviewColumns],
	);

	useEffect(() => {
		if (!pendingEditRequest || isCellContextMenuOpen) {
			return;
		}

		handleOpenEditDialog(pendingEditRequest.row, pendingEditRequest.column);
		setPendingEditRequest(null);
	}, [pendingEditRequest, isCellContextMenuOpen, handleOpenEditDialog]);

	const handleSaveRowEdit = async () => {
		if (!editingCell) {
			return;
		}

		console.log("[DatabasesView] save row edit", {
			table: selectedTableLabel,
			columnCount: Object.keys(rowDraft).length,
		});

		const updates = Object.fromEntries(
			Object.entries(rowDraft).map(([column, draft]) => [
				column,
				draft.isNull
					? null
					: normalizeDraftValue(draft.value, editingCell.row[column]),
			]),
		);

		try {
			await applyRowUpdate({ row: editingCell.row, updates });
			editDialogOpenedAtRef.current = 0;
			setIsEditDialogOpen(false);
			setEditingCell(null);
			setRowDraft({});
		} catch (error) {
			setQueryError(
				error instanceof Error ? error.message : "Failed to update row.",
			);
		}
	};

	const handleCopyRow = async (row: Record<string, unknown>) => {
		const payload = Object.fromEntries(
			visiblePreviewColumns.map((column) => [column, row[column]]),
		);
		await copyToClipboard(JSON.stringify(payload, null, 2));
	};

	const handleQuickCellUpdate = async ({
		row,
		column,
		value,
	}: {
		row: Record<string, unknown>;
		column: string;
		value: unknown;
	}) => {
		console.log("[DatabasesView] quick cell update", {
			table: selectedTableLabel,
			column,
			value,
		});
		try {
			await applyRowUpdate({ row, updates: { [column]: value } });
		} catch (error) {
			setQueryError(
				error instanceof Error ? error.message : "Failed to update cell.",
			);
		}
	};

	const toggleSchemaGroup = (schemaKey: string) => {
		console.log("[DatabasesView] toggle schema", {
			schemaKey,
			nextOpen: !expandedSchemaKeys[schemaKey],
		});
		setExpandedSchemaKeys((current) => ({
			...current,
			[schemaKey]: !current[schemaKey],
		}));
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="shrink-0 border-b p-3">
				<div className="mb-3 flex items-center justify-between">
					<div>
						<h2 className="text-sm font-semibold">
							{isPaneMode ? "Database Explorer" : "Databases"}
						</h2>
						<p className="text-muted-foreground text-xs">
							{isPaneMode
								? "Browse schema, data, and queries in a full tab"
								: "Manage SQLite and PostgreSQL connections"}
						</p>
					</div>
					{isSidebarMode ? (
						<Button
							variant="outline"
							size="sm"
							type="button"
							onClick={() => discoverQuery.refetch()}
							disabled={!worktreePath || discoverQuery.isFetching}
						>
							<LuRefreshCw
								className={cn(
									"mr-1.5 size-3.5",
									discoverQuery.isFetching && "animate-spin",
								)}
							/>
							Refresh
						</Button>
					) : null}
				</div>

				{isSidebarMode ? (
					<Collapsible
						open={isAddConnectionOpen}
						onOpenChange={setIsAddConnectionOpen}
						className="rounded-lg border"
					>
						<div className="flex items-center justify-between p-3">
							<div>
								<p className="text-sm font-medium">
									{editingConnectionId ? "接続を編集" : "新しい接続を追加"}
								</p>
								<p className="text-muted-foreground text-[11px]">
									必要なときだけ開けます
								</p>
							</div>
							<CollapsibleTrigger asChild>
								<Button variant="outline" size="sm" type="button">
									<LuPlus className="mr-1.5 size-3.5" />
									{isAddConnectionOpen ? "閉じる" : "開く"}
									<LuChevronDown
										className={cn(
											"ml-1.5 size-3.5 transition-transform",
											isAddConnectionOpen && "rotate-180",
										)}
									/>
								</Button>
							</CollapsibleTrigger>
						</div>

						<CollapsibleContent className="border-t p-3">
							<div className="space-y-3">
								<div className="grid grid-cols-2 gap-2">
									<Button
										type="button"
										variant={
											connectionType === "sqlite" ? "default" : "outline"
										}
										size="sm"
										onClick={() => setConnectionType("sqlite")}
									>
										SQLite
									</Button>
									<Button
										type="button"
										variant={
											connectionType === "postgres" ? "default" : "outline"
										}
										size="sm"
										onClick={() => setConnectionType("postgres")}
									>
										Postgres
									</Button>
								</div>

								<div className="grid grid-cols-2 gap-3">
									<div className="space-y-1">
										<Label htmlFor="db-label">名前</Label>
										<Input
											id="db-label"
											ref={labelInputRef}
											value={labelInput}
											onChange={(event) => {
												setLabelInput(event.target.value);
												setFormError(null);
											}}
											placeholder="Local Postgres"
										/>
									</div>
									<div className="space-y-1">
										<Label htmlFor="db-group">グループ</Label>
										<Input
											id="db-group"
											ref={groupInputRef}
											value={groupInput}
											onChange={(event) => {
												setGroupInput(event.target.value);
												setFormError(null);
											}}
											placeholder="親/子"
										/>
									</div>
								</div>

								{connectionType === "sqlite" ? (
									<div className="space-y-1">
										<Label htmlFor="sqlite-path">SQLite ファイル</Label>
										<Input
											id="sqlite-path"
											ref={pathInputRef}
											value={pathInput}
											onChange={(event) => {
												setPathInput(event.target.value);
												setFormError(null);
											}}
											placeholder={
												worktreePath
													? "SQLite file path (absolute or workspace-relative)"
													: "Absolute SQLite file path"
											}
										/>
									</div>
								) : (
									<div className="space-y-3">
										<div className="flex items-center justify-between rounded-md border px-3 py-2">
											<div>
												<p className="text-sm font-medium">接続文字列を使用</p>
												<p className="text-muted-foreground text-[11px]">
													有効にすると PostgreSQL URL を直接入力します
												</p>
											</div>
											<Switch
												checked={useConnectionString}
												onCheckedChange={setUseConnectionString}
											/>
										</div>

										{useConnectionString ? (
											<div className="space-y-1">
												<Label htmlFor="postgres-url">接続文字列</Label>
												<Input
													id="postgres-url"
													ref={pathInputRef}
													value={pathInput}
													onChange={(event) => {
														setPathInput(event.target.value);
														setFormError(null);
													}}
													placeholder="postgres://user:password@host:5432/database"
												/>
											</div>
										) : (
											<>
												<div className="grid grid-cols-2 gap-3">
													<div className="space-y-1">
														<Label htmlFor="postgres-host">ホスト</Label>
														<Input
															id="postgres-host"
															ref={postgresHostRef}
															value={postgresHost}
															onChange={(event) => {
																setPostgresHost(event.target.value);
																setFormError(null);
															}}
															placeholder="127.0.0.1"
														/>
													</div>
													<div className="space-y-1">
														<Label htmlFor="postgres-port">ポート</Label>
														<Input
															id="postgres-port"
															ref={postgresPortRef}
															value={postgresPort}
															onChange={(event) => {
																setPostgresPort(event.target.value);
																setFormError(null);
															}}
															placeholder="5432"
														/>
													</div>
												</div>

												<div className="grid grid-cols-2 gap-3">
													<div className="space-y-1">
														<Label htmlFor="postgres-user">ユーザー名</Label>
														<Input
															id="postgres-user"
															ref={postgresUsernameRef}
															value={postgresUsername}
															onChange={(event) => {
																setPostgresUsername(event.target.value);
																setFormError(null);
															}}
															placeholder="postgres"
														/>
													</div>
													<div className="space-y-1">
														<Label htmlFor="postgres-password">
															パスワード
														</Label>
														<div className="relative">
															<Input
																id="postgres-password"
																ref={postgresPasswordRef}
																type={showPassword ? "text" : "password"}
																value={postgresPassword}
																onChange={(event) => {
																	setPostgresPassword(event.target.value);
																	setFormError(null);
																}}
																placeholder="password"
																className="pr-10"
															/>
															<button
																type="button"
																aria-label={
																	showPassword
																		? "Hide password"
																		: "Show password"
																}
																onClick={() =>
																	setShowPassword((value) => !value)
																}
																className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
															>
																{showPassword ? (
																	<LuEyeOff className="size-4" />
																) : (
																	<LuEye className="size-4" />
																)}
															</button>
														</div>
													</div>
												</div>

												<div className="grid grid-cols-2 gap-3">
													<div className="space-y-1">
														<Label htmlFor="postgres-db">データベース</Label>
														<Input
															id="postgres-db"
															ref={postgresDatabaseRef}
															value={postgresDatabase}
															onChange={(event) => {
																setPostgresDatabase(event.target.value);
																setFormError(null);
															}}
															placeholder="postgres (optional)"
														/>
														<p className="text-muted-foreground text-[11px]">
															未入力なら `postgres` に接続します
														</p>
													</div>
													<div className="flex items-end">
														<div className="flex w-full items-center justify-between rounded-md border px-3 py-2">
															<div>
																<p className="text-sm font-medium">SSL</p>
																<p className="text-muted-foreground text-[11px]">
																	`sslmode=require`
																</p>
															</div>
															<Switch
																checked={postgresSsl}
																onCheckedChange={setPostgresSsl}
															/>
														</div>
													</div>
												</div>
											</>
										)}
									</div>
								)}

								<div className="flex items-center justify-between gap-2">
									<p className="text-muted-foreground truncate text-[11px]">
										{connectionType === "sqlite"
											? worktreePath
												? `Workspace root: ${worktreePath}`
												: "No workspace root available"
											: "Use a PostgreSQL connection string"}
									</p>
									<div className="flex items-center gap-2">
										{editingConnectionId ? (
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => {
													resetConnectionForm();
													setIsAddConnectionOpen(false);
												}}
											>
												キャンセル
											</Button>
										) : null}
										<Button
											type="button"
											size="sm"
											onClick={handleAddConnection}
										>
											<LuPlus className="mr-1.5 size-3.5" />
											{editingConnectionId ? "更新" : "保存"}
										</Button>
									</div>
								</div>

								{formError ? (
									<Alert variant="destructive">
										<AlertTitle>Add connection failed</AlertTitle>
										<AlertDescription>{formError}</AlertDescription>
									</Alert>
								) : null}
							</div>
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</div>

			<div className="flex-1 min-h-0 overflow-hidden">
				{isSidebarMode ? (
					<div className="h-full overflow-y-auto">
						<section className="border-b p-3">
							<div className="mb-2 flex items-center justify-between">
								<h3 className="text-sm font-medium">Saved connections</h3>
								<Badge variant="outline">{connections.length}</Badge>
							</div>
							<div className="space-y-2">
								{connections.length > 0 ? (
									connections.map((connection) => (
										<ConnectionItem
											key={connection.id}
											connection={connection}
											isActive={connection.id === resolvedSelectedConnectionId}
											onOpen={
												onOpenExplorer
													? () => {
															handleSelectConnectionId(connection.id);
															onOpenExplorer(connection.id);
														}
													: undefined
											}
											onEdit={() => {
												populateConnectionForm(connection);
												setIsAddConnectionOpen(true);
											}}
											onSelect={() => handleSelectConnectionId(connection.id)}
											onRemove={() => removeConnection(connection.id)}
										/>
									))
								) : (
									<Empty className="min-h-0 border border-dashed p-4">
										<EmptyHeader className="max-w-none">
											<EmptyMedia variant="icon">
												<LuDatabase />
											</EmptyMedia>
											<EmptyTitle>No database connections</EmptyTitle>
											<EmptyDescription>
												Add a database connection to inspect schema and run
												queries.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								)}
							</div>
						</section>

						<section className="border-b p-3">
							<div className="flex items-center justify-between gap-2">
								<div>
									<h3 className="text-sm font-medium">Explorer</h3>
									<p className="text-muted-foreground text-[11px]">
										スキーマやデータは専用タブで開きます
									</p>
								</div>
								<Button
									type="button"
									size="sm"
									onClick={() =>
										activeConnection && onOpenExplorer?.(activeConnection.id)
									}
									disabled={!activeConnection}
								>
									<LuExternalLink className="mr-1.5 size-3.5" />
									Open Explorer
								</Button>
							</div>
						</section>

						<section className="border-b p-3">
							<div className="mb-2 flex items-center justify-between">
								<h3 className="text-sm font-medium">
									Detected workspace databases
								</h3>
								<Badge variant="outline">
									{discoverQuery.data?.files.length ?? 0}
								</Badge>
							</div>
							{discoveredFiles.length > 0 ? (
								<div className="space-y-2">
									{discoveredFiles.map((file) => (
										<div
											key={file.absolutePath}
											className="flex items-center gap-2 rounded-md border p-2"
										>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{guessConnectionLabel(file.absolutePath)}
												</p>
												<p className="text-muted-foreground truncate font-mono text-[11px]">
													{file.relativePath}
												</p>
											</div>
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() =>
													handleAttachDiscoveredFile(file.absolutePath)
												}
											>
												<LuPlus className="mr-1.5 size-3.5" />
												Attach
											</Button>
										</div>
									))}
								</div>
							) : (
								<p className="text-muted-foreground text-sm">
									{worktreePath
										? "No SQLite-like files detected in this workspace."
										: "Open a workspace to auto-discover SQLite files."}
								</p>
							)}
						</section>
					</div>
				) : (
					<ResizablePanelGroup direction="horizontal" className="h-full">
						<ResizablePanel defaultSize={24} minSize={18}>
							<div className="h-full overflow-y-auto border-r">
								<section className="border-b p-3">
									<div className="mb-2 flex items-center justify-between">
										<h3 className="text-sm font-medium">Connections</h3>
										<Badge variant="outline">{connections.length}</Badge>
									</div>
									<div className="space-y-1">
										{connections.map((connection) => (
											<button
												key={connection.id}
												type="button"
												className={cn(
													"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
													connection.id === resolvedSelectedConnectionId
														? "bg-accent text-accent-foreground"
														: "hover:bg-muted/50",
												)}
												onClick={() => handleSelectConnectionId(connection.id)}
											>
												<LuDatabase className="size-3.5 shrink-0 text-muted-foreground" />
												<span className="truncate">{connection.label}</span>
											</button>
										))}
									</div>
								</section>

								<section className="p-2">
									<div className="mb-2 px-1">
										<h3 className="text-sm font-medium">Schema</h3>
									</div>
									{!activeConnection ? (
										<p className="text-muted-foreground px-2 text-sm">
											接続を選択してください。
										</p>
									) : activeSchemaQuery.isLoading ? (
										<p className="text-muted-foreground px-2 text-sm">
											Loading schema...
										</p>
									) : activeSchemaQuery.error ? (
										<Alert variant="destructive" className="mx-1">
											<AlertTitle>Schema load failed</AlertTitle>
											<AlertDescription>
												{activeSchemaQuery.error.message}
											</AlertDescription>
										</Alert>
									) : tablesBySchema.length ? (
										<div className="space-y-1">
											{tablesBySchema.map((group) => (
												<div key={group.schemaKey} className="rounded-md">
													<button
														type="button"
														className="hover:bg-muted/50 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm"
														onClick={() => toggleSchemaGroup(group.schemaKey)}
													>
														{expandedSchemaKeys[group.schemaKey] ? (
															<LuChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
														) : (
															<LuChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
														)}
														<span className="truncate font-medium">
															{group.label}
														</span>
														<Badge variant="outline" className="ml-auto">
															{group.tables.length}
														</Badge>
													</button>
													{expandedSchemaKeys[group.schemaKey] ? (
														<div className="mt-1 space-y-0.5 pl-5">
															{group.tables.map((table) => (
																<button
																	key={getTableKey(table)}
																	type="button"
																	className={cn(
																		"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
																		selectedTableKey === getTableKey(table)
																			? "bg-accent text-accent-foreground"
																			: "hover:bg-muted/50",
																	)}
																	onClick={() => {
																		console.log(
																			"[DatabasesView] select table",
																			{
																				connectionId: activeConnection?.id,
																				table: table.schema
																					? `${table.schema}.${table.name}`
																					: table.name,
																			},
																		);
																		setSelectedTableKey(getTableKey(table));
																		setTablePreviewPage(0);
																	}}
																>
																	<LuTable2 className="size-3.5 shrink-0 text-muted-foreground" />
																	<span className="truncate">{table.name}</span>
																</button>
															))}
														</div>
													) : null}
												</div>
											))}
										</div>
									) : (
										<p className="text-muted-foreground px-2 text-sm">
											No user tables found in this database.
										</p>
									)}
								</section>
							</div>
						</ResizablePanel>
						<ResizableHandle withHandle />
						<ResizablePanel defaultSize={76} minSize={45}>
							<div className="h-full overflow-y-auto">
								<section className="border-b p-3">
									<div className="mb-2 flex items-center justify-between gap-2">
										<div>
											<h3 className="text-sm font-medium">Table data</h3>
											<p className="text-muted-foreground text-[11px]">
												左のツリーからテーブルを選ぶと先頭{" "}
												{TABLE_PREVIEW_PAGE_SIZE} 件ずつ表示します
											</p>
										</div>
										<div className="flex items-center gap-2">
											{selectedTable ? (
												<Badge variant="outline">{selectedTableLabel}</Badge>
											) : null}
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => activePreviewQuery.refetch()}
												disabled={
													!selectedTable || activePreviewQuery.isFetching
												}
											>
												<LuRefreshCw
													className={cn(
														"mr-1.5 size-3.5",
														activePreviewQuery.isFetching && "animate-spin",
													)}
												/>
												更新
											</Button>
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => setIsSqlDialogOpen(true)}
												disabled={!activeConnection}
											>
												<LuPlay className="mr-1.5 size-3.5" />
												SQL
											</Button>
										</div>
									</div>

									{!activeConnection ? (
										<p className="text-muted-foreground text-sm">
											Select a saved connection to browse table rows.
										</p>
									) : !selectedTable ? (
										<p className="text-muted-foreground text-sm">
											左のツリーからテーブルを選択してください。
										</p>
									) : activePreviewQuery.isLoading ? (
										<p className="text-muted-foreground text-sm">
											Loading table data...
										</p>
									) : activePreviewQuery.error ? (
										<Alert variant="destructive">
											<AlertTitle>Table preview failed</AlertTitle>
											<AlertDescription>
												{activePreviewQuery.error.message}
											</AlertDescription>
										</Alert>
									) : activePreviewQuery.data ? (
										<div className="space-y-3">
											<div className="flex items-center gap-2 text-xs">
												<Badge variant="outline">
													{activePreviewQuery.data.rows.length} rows shown
												</Badge>
												<Badge variant="outline">
													{activePreviewQuery.data.elapsedMs} ms
												</Badge>
												<Badge variant="outline">
													{activePreviewQuery.data.rows.length > 0
														? `${activePreviewQuery.data.offset + 1}-${
																activePreviewQuery.data.offset +
																activePreviewQuery.data.rows.length
															}`
														: "0 rows"}
												</Badge>
												{activePreviewQuery.data.hasMore ? (
													<Badge variant="outline">more available</Badge>
												) : null}
											</div>
											<ContextMenu
												open={isCellContextMenuOpen}
												onOpenChange={setIsCellContextMenuOpen}
											>
												<ContextMenuTrigger asChild>
													<div className="overflow-hidden rounded-md border">
														<div className="max-h-[42rem] overflow-auto">
															<Table className="min-w-max">
																<TableHeader>
																	<TableRow>
																		{activePreviewQuery.data.columns.map(
																			(column) => (
																				<TableHead
																					key={column}
																					className="whitespace-nowrap"
																				>
																					{column}
																				</TableHead>
																			),
																		)}
																	</TableRow>
																</TableHeader>
																<TableBody>
																	{previewRows.length > 0 ? (
																		previewRows.map((row, index) => (
																			<TableRow
																				key={`${index}-${activePreviewQuery.data.columns.join("-")}`}
																			>
																				{activePreviewQuery.data.columns.map(
																					(column) => (
																						<TableCell
																							key={`${index}-${column}`}
																							className="max-w-[24rem] align-top font-mono text-[11px]"
																						>
																							<PreviewTableCellValue
																								value={row[column]}
																								onContextMenu={() => {
																									const formattedValue =
																										formatCellValue(
																											row[column],
																										);
																									setContextCell({
																										row,
																										column,
																										display: formattedValue,
																										title: formattedValue,
																									});
																								}}
																							/>
																						</TableCell>
																					),
																				)}
																			</TableRow>
																		))
																	) : (
																		<TableRow>
																			<TableCell
																				colSpan={Math.max(
																					activePreviewQuery.data.columns
																						.length,
																					1,
																				)}
																				className="text-muted-foreground text-center text-sm"
																			>
																				No rows found in this table.
																			</TableCell>
																		</TableRow>
																	)}
																</TableBody>
															</Table>
														</div>
													</div>
												</ContextMenuTrigger>
												<ContextMenuContent>
													<ContextMenuItem
														disabled={!contextCell}
														onSelect={() =>
															contextCell
																? copyToClipboard(contextCell.display)
																: undefined
														}
													>
														<LuCopy className="mr-2 size-4" />
														コピー
													</ContextMenuItem>
													<ContextMenuItem
														disabled={!contextCell}
														onSelect={() => {
															if (!contextCell) {
																return;
															}
															setPendingEditRequest({
																row: contextCell.row,
																column: contextCell.column,
															});
															setIsCellContextMenuOpen(false);
														}}
													>
														<LuPencil className="mr-2 size-4" />
														編集
													</ContextMenuItem>
													<ContextMenuItem
														disabled={!contextCell}
														onSelect={() =>
															contextCell
																? handleCopyRow(contextCell.row)
																: undefined
														}
													>
														<LuCopy className="mr-2 size-4" />
														行をコピー
													</ContextMenuItem>
													<ContextMenuSeparator />
													<ContextMenuItem
														disabled={!contextCell}
														onSelect={() =>
															contextCell
																? handleQuickCellUpdate({
																		row: contextCell.row,
																		column: contextCell.column,
																		value: null,
																	})
																: undefined
														}
													>
														<LuEraser className="mr-2 size-4" />
														NULLに設定
													</ContextMenuItem>
													<ContextMenuItem
														disabled={!contextCell}
														onSelect={() =>
															contextCell
																? handleQuickCellUpdate({
																		row: contextCell.row,
																		column: contextCell.column,
																		value: "",
																	})
																: undefined
														}
													>
														<LuEraser className="mr-2 size-4" />
														空の文字列に設定
													</ContextMenuItem>
												</ContextMenuContent>
											</ContextMenu>
											<div className="flex items-center justify-end gap-2">
												<Button
													type="button"
													size="sm"
													variant="outline"
													onClick={() =>
														setTablePreviewPage((page) => Math.max(page - 1, 0))
													}
													disabled={tablePreviewPage === 0}
												>
													前へ
												</Button>
												<Button
													type="button"
													size="sm"
													variant="outline"
													onClick={() =>
														setTablePreviewPage((page) => page + 1)
													}
													disabled={!activePreviewQuery.data.hasMore}
												>
													次へ
												</Button>
											</div>
										</div>
									) : (
										<p className="text-muted-foreground text-sm">
											Select a table to preview its rows.
										</p>
									)}
								</section>
							</div>
						</ResizablePanel>
					</ResizablePanelGroup>
				)}
			</div>
			<Dialog open={isSqlDialogOpen} onOpenChange={setIsSqlDialogOpen}>
				<DialogContent className="flex max-h-[85vh] !max-w-[72rem] flex-col overflow-hidden">
					<DialogHeader>
						<DialogTitle>
							SQL Runner
							{selectedTableLabel ? ` · ${selectedTableLabel}` : ""}
						</DialogTitle>
						<DialogDescription>
							選択中のデータベース接続に対して SQL を実行します。
						</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-1 flex-col gap-3">
						<Textarea
							value={sql}
							onChange={(event) => setSql(event.target.value)}
							className="min-h-40 font-mono text-[12px]"
						/>
						{queryError ? (
							<Alert variant="destructive">
								<AlertTitle>Query failed</AlertTitle>
								<AlertDescription>{queryError}</AlertDescription>
							</Alert>
						) : null}
						<div className="min-h-0 flex-1 overflow-hidden rounded-md border">
							<div className="h-full max-h-[26rem] overflow-auto p-3">
								{isQueryRunning ? (
									<p className="text-muted-foreground text-sm">
										Running query...
									</p>
								) : queryResult ? (
									<div className="space-y-3">
										<div className="flex items-center gap-2 text-xs">
											<Badge variant="outline">
												{queryResult.rowCount} rows
											</Badge>
											<Badge variant="outline">
												{queryResult.elapsedMs} ms
											</Badge>
											{queryResult.command ? (
												<Badge variant="outline">{queryResult.command}</Badge>
											) : null}
											{queryResult.truncated ? (
												<Badge variant="outline">Truncated to 200 rows</Badge>
											) : null}
											{queryResult.lastInsertRowid ? (
												<Badge variant="outline">
													last id {String(queryResult.lastInsertRowid)}
												</Badge>
											) : null}
										</div>
										<div className="overflow-hidden rounded-md border">
											<div className="max-h-80 overflow-auto">
												<Table className="min-w-max">
													<TableHeader>
														<TableRow>
															{queryResult.columns.map((column) => (
																<TableHead
																	key={column}
																	className="whitespace-nowrap"
																>
																	{column}
																</TableHead>
															))}
														</TableRow>
													</TableHeader>
													<TableBody>
														{queryResult.rows.length > 0 ? (
															queryResult.rows.map((row, index) => (
																<TableRow
																	key={`${index}-${queryResult.columns.join("-")}`}
																>
																	{queryResult.columns.map((column) => (
																		<TableCell
																			key={`${index}-${column}`}
																			className="max-w-[24rem] align-top font-mono text-[11px]"
																		>
																			<div className="overflow-hidden text-ellipsis whitespace-nowrap">
																				{formatCellValue(row[column])}
																			</div>
																		</TableCell>
																	))}
																</TableRow>
															))
														) : (
															<TableRow>
																<TableCell
																	colSpan={Math.max(
																		queryResult.columns.length,
																		1,
																	)}
																	className="text-muted-foreground text-center text-sm"
																>
																	Query completed with no result rows.
																</TableCell>
															</TableRow>
														)}
													</TableBody>
												</Table>
											</div>
										</div>
									</div>
								) : (
									<Empty className="min-h-0 border-0 p-0">
										<EmptyContent className="max-w-none">
											<EmptyHeader className="max-w-none">
												<EmptyMedia variant="icon">
													<LuPlay />
												</EmptyMedia>
												<EmptyTitle>No query results yet</EmptyTitle>
												<EmptyDescription>
													Run a query against the selected database connection.
												</EmptyDescription>
											</EmptyHeader>
										</EmptyContent>
									</Empty>
								)}
							</div>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setIsSqlDialogOpen(false)}
						>
							閉じる
						</Button>
						<Button
							type="button"
							onClick={() => void handleRunQuery()}
							disabled={!activeConnection || isQueryRunning}
						>
							<LuPlay className="mr-1.5 size-3.5" />
							Run
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				open={isEditDialogOpen}
				onOpenChange={(open) => {
					if (!open && Date.now() - editDialogOpenedAtRef.current < 300) {
						console.log("[DatabasesView] ignore immediate edit dialog close");
						return;
					}

					if (!open) {
						setIsEditDialogOpen(false);
						setPendingEditRequest(null);
						setEditingCell(null);
						setRowDraft({});
					}
				}}
			>
				<DialogContent className="flex max-h-[85vh] !max-w-[72rem] flex-col overflow-hidden">
					<DialogHeader>
						<DialogTitle>
							Edit For{" "}
							{selectedTableLabel ? `"${selectedTableLabel}"` : "table"}
						</DialogTitle>
						<DialogDescription>
							選択した行の各カラム値を編集します。
						</DialogDescription>
					</DialogHeader>
					<div className="grid max-h-[60vh] grid-cols-2 gap-4 overflow-y-auto pr-1">
						{editingCell
							? visiblePreviewColumns.map((column) => {
									const draft = rowDraft[column] ?? {
										value: "",
										isNull: false,
									};
									return (
										<div key={column} className="space-y-1">
											<div className="flex items-center justify-between gap-2">
												<Label htmlFor={`edit-row-${column}`}>{column}</Label>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													onClick={() =>
														setRowDraft((current) => ({
															...current,
															[column]: { value: "", isNull: true },
														}))
													}
												>
													NULL
												</Button>
											</div>
											<Input
												id={`edit-row-${column}`}
												value={draft.isNull ? "" : draft.value}
												onChange={(event) =>
													setRowDraft((current) => ({
														...current,
														[column]: {
															value: event.target.value,
															isNull: false,
														},
													}))
												}
												placeholder={draft.isNull ? "NULL" : column}
											/>
										</div>
									);
								})
							: null}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								editDialogOpenedAtRef.current = 0;
								setIsEditDialogOpen(false);
								setEditingCell(null);
								setRowDraft({});
							}}
						>
							キャンセル
						</Button>
						<Button type="button" onClick={() => void handleSaveRowEdit()}>
							更新
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
