import { Alert, AlertDescription, AlertTitle } from "@superset/ui/alert";
import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
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
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@superset/ui/resizable";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { toast } from "@superset/ui/sonner";
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
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
	memo,
	startTransition,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	LuArrowDown,
	LuArrowUp,
	LuArrowUpDown,
	LuChevronDown,
	LuChevronRight,
	LuCopy,
	LuDatabase,
	LuEraser,
	LuExternalLink,
	LuEye,
	LuEyeOff,
	LuFilter,
	LuPencil,
	LuPlay,
	LuPlus,
	LuRefreshCw,
	LuSearch,
	LuTable2,
	LuTrash2,
	LuX,
} from "react-icons/lu";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer/MarkdownRenderer";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import {
	type SavedDatabaseConnection,
	type SavedDatabaseQueryHistoryItem,
	useDatabaseSidebarStore,
} from "renderer/stores/database-sidebar";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";

const SQLITE_ROW_ID_COLUMN = "__superset_rowid";
const SQLITE_PRIMARY_KEY_COLUMN = "__superset_primary_key";
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
const TABLE_PREVIEW_ROW_HEIGHT = 34;
const TABLE_PREVIEW_OVERSCAN = 10;

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
	mode: "edit" | "insert" | "duplicate";
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
	mode?: EditableCellState["mode"];
}

interface TableSortState {
	column: string;
	direction: "asc" | "desc";
}

interface CellDetailState {
	row: Record<string, unknown>;
	column: string;
	columnType: string;
	value: unknown;
	format: "text" | "json" | "markdown";
	draft: string;
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

function getWorkspaceConfigPostgresLabel(input: {
	host: string;
	databaseName: string;
}): string {
	return input.databaseName
		? `${input.host}/${input.databaseName}`
		: input.host;
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

function getRowIdentifier(
	row: Record<string, unknown>,
	dialect: ConnectionDialect,
): string | null {
	const identifier =
		dialect === "sqlite"
			? (row[SQLITE_PRIMARY_KEY_COLUMN] ?? row[SQLITE_ROW_ID_COLUMN])
			: row[POSTGRES_ROW_ID_COLUMN];

	if (identifier === undefined || identifier === null) {
		return null;
	}

	return String(identifier);
}

function matchesSearchValue(value: unknown, query: string): boolean {
	if (!query) return true;
	return formatCellValue(value).toLowerCase().includes(query);
}

function comparePreviewValues(left: unknown, right: unknown): number {
	if (left === right) return 0;
	if (left === null || left === undefined) return 1;
	if (right === null || right === undefined) return -1;
	if (typeof left === "number" && typeof right === "number") {
		return left - right;
	}
	if (typeof left === "boolean" && typeof right === "boolean") {
		return Number(left) - Number(right);
	}
	if (left instanceof Date && right instanceof Date) {
		return left.getTime() - right.getTime();
	}

	return formatCellValue(left).localeCompare(
		formatCellValue(right),
		undefined,
		{
			numeric: true,
			sensitivity: "base",
		},
	);
}

function toCsvCell(value: unknown): string {
	const stringValue = formatCellValue(value);
	return `"${stringValue.replaceAll('"', '""')}"`;
}

function normalizeColumnType(type: string | null | undefined): string {
	return (type ?? "").toLowerCase();
}

function supportsDetailViewer(columnType: string, value: unknown): boolean {
	const normalizedType = normalizeColumnType(columnType);
	if (
		normalizedType.includes("json") ||
		normalizedType.includes("text") ||
		normalizedType.includes("char") ||
		normalizedType.includes("citext") ||
		normalizedType.includes("xml") ||
		normalizedType.includes("array") ||
		normalizedType.includes("bytea") ||
		normalizedType.includes("blob") ||
		normalizedType.includes("vector") ||
		normalizedType.includes("hstore") ||
		normalizedType.includes("geometry") ||
		normalizedType.includes("geography") ||
		normalizedType.includes("tsvector") ||
		normalizedType.includes("tsquery")
	) {
		return true;
	}

	return typeof value === "string" && value.length > 80;
}

function canUseJsonDetailFormat(columnType: string, value: unknown): boolean {
	const normalizedType = normalizeColumnType(columnType);
	if (
		normalizedType.includes("json") ||
		normalizedType.includes("array") ||
		Array.isArray(value) ||
		(typeof value === "object" && value !== null)
	) {
		return true;
	}

	if (typeof value !== "string") {
		return false;
	}

	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

function canUseMarkdownDetailFormat(
	columnType: string,
	value: unknown,
): boolean {
	const normalizedType = normalizeColumnType(columnType);
	if (
		normalizedType.includes("json") ||
		normalizedType.includes("array") ||
		normalizedType.includes("bytea") ||
		normalizedType.includes("blob")
	) {
		return false;
	}

	return typeof value === "string";
}

function formatCellDetailDraft(
	value: unknown,
	format: "text" | "json" | "markdown",
): string {
	if (format === "json") {
		if (typeof value === "string") {
			try {
				return JSON.stringify(JSON.parse(value), null, 2);
			} catch {
				return value;
			}
		}
		return JSON.stringify(value, null, 2);
	}

	return formatCellValue(value);
}

function buildSqliteRowSelector(row: Record<string, unknown>): string {
	const primaryKeyPayload = row[SQLITE_PRIMARY_KEY_COLUMN];
	if (typeof primaryKeyPayload === "string" && primaryKeyPayload.length > 0) {
		try {
			const parsed = JSON.parse(primaryKeyPayload) as Record<string, unknown>;
			const clauses = Object.entries(parsed).map(([column, value]) =>
				value === null
					? `${quoteSqlIdentifier(column)} IS NULL`
					: `${quoteSqlIdentifier(column)} = ${toSqlLiteral(value, "sqlite")}`,
			);
			if (clauses.length > 0) {
				return clauses.join(" AND ");
			}
		} catch {
			// Fall back to rowid below if the preview metadata is malformed.
		}
	}

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
	row,
	column,
	onOpenContextMenu,
	canOpenDetail,
	onOpenDetail,
}: {
	row: Record<string, unknown>;
	column: string;
	onOpenContextMenu: (row: Record<string, unknown>, column: string) => void;
	canOpenDetail: boolean;
	onOpenDetail: (row: Record<string, unknown>, column: string) => void;
}) {
	const value = row[column];
	const formattedValue = useMemo(() => formatCellValue(value), [value]);

	return (
		<div className="group flex items-center gap-1">
			<button
				type="button"
				className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left"
				title={formattedValue}
				onContextMenu={() => onOpenContextMenu(row, column)}
			>
				{formattedValue}
			</button>
			{canOpenDetail ? (
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground size-5 shrink-0 rounded opacity-0 transition-opacity group-hover:opacity-100"
					onClick={(event) => {
						event.stopPropagation();
						onOpenDetail(row, column);
					}}
					aria-label={`Open full value for ${column}`}
				>
					<LuSearch className="size-3.5" />
				</button>
			) : null}
		</div>
	);
});

const PreviewTableRowView = memo(function PreviewTableRowView({
	row,
	rowId,
	columns,
	selected,
	onToggleSelection,
	onOpenContextMenu,
	getCanOpenDetail,
	onOpenDetail,
	dataIndex,
}: {
	row: Record<string, unknown>;
	rowId: string | null;
	columns: string[];
	selected: boolean;
	onToggleSelection: (row: Record<string, unknown>, checked: boolean) => void;
	onOpenContextMenu: (row: Record<string, unknown>, column: string) => void;
	getCanOpenDetail: (column: string, value: unknown) => boolean;
	onOpenDetail: (row: Record<string, unknown>, column: string) => void;
	dataIndex?: number;
}) {
	return (
		<TableRow data-index={dataIndex}>
			<TableCell className="w-10 min-w-10">
				<Checkbox
					checked={selected}
					onCheckedChange={(checked) =>
						onToggleSelection(row, Boolean(checked))
					}
					aria-label="Select row"
				/>
			</TableCell>
			{columns.map((column) => (
				<TableCell
					key={`${rowId ?? "row"}-${column}`}
					className="max-w-[24rem] align-top font-mono text-[11px]"
				>
					<PreviewTableCellValue
						row={row}
						column={column}
						onOpenContextMenu={onOpenContextMenu}
						canOpenDetail={getCanOpenDetail(column, row[column])}
						onOpenDetail={onOpenDetail}
					/>
				</TableCell>
			))}
		</TableRow>
	);
});

function getConnectionSubtitle(connection: SavedDatabaseConnection): string {
	if (
		connection.dialect === "postgres" &&
		connection.source === "workspace-config"
	) {
		return getWorkspaceConfigPostgresLabel({
			host: connection.host ?? "postgres",
			databaseName: connection.databaseName ?? "",
		});
	}

	return connection.dialect === "sqlite"
		? (connection.databasePath ?? "")
		: (connection.connectionString ?? "");
}

function getPostgresConnectionInput(connection: SavedDatabaseConnection | null) {
	if (!connection || connection.dialect !== "postgres") {
		return null;
	}

	if (
		connection.source === "workspace-config" &&
		connection.workspacePath &&
		connection.workspaceDefinitionId
	) {
		return {
			kind: "workspaceConfig" as const,
			workspacePath: connection.workspacePath,
			definitionId: connection.workspaceDefinitionId,
		};
	}

	if (connection.connectionString) {
		return {
			kind: "connectionString" as const,
			connectionString: connection.connectionString,
		};
	}

	return null;
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

type DiscoveredWorkspaceDatabaseItem =
	| {
			source: "file";
			dialect: "sqlite";
			absolutePath: string;
			relativePath: string;
	  }
	| {
			source: "config";
			dialect: "sqlite";
			definitionId: string;
			label: string;
			group?: string;
			absolutePath: string;
			relativePath: string;
	  }
	| {
			source: "config";
			dialect: "postgres";
			definitionId: string;
			label: string;
			group?: string;
			host: string;
			port: number;
			database: string;
			ssl: boolean;
			usernameHint?: string;
			relativePath: string;
			hasSavedCredentials: boolean;
	  };

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
	const trpcUtils = electronTrpc.useUtils();

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
	const queryHistory = useDatabaseSidebarStore((state) => state.queryHistory);
	const addQueryHistoryItem = useDatabaseSidebarStore(
		(state) => state.addQueryHistoryItem,
	);
	const removeQueryHistoryItem = useDatabaseSidebarStore(
		(state) => state.removeQueryHistoryItem,
	);
	const clearQueryHistoryForConnection = useDatabaseSidebarStore(
		(state) => state.clearQueryHistoryForConnection,
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
	const [isCredentialPromptOpen, setIsCredentialPromptOpen] = useState(false);
	const [credentialPromptTarget, setCredentialPromptTarget] =
		useState<Extract<DiscoveredWorkspaceDatabaseItem, { dialect: "postgres" }> | null>(
			null,
		);
	const [configUsername, setConfigUsername] = useState("");
	const [configPassword, setConfigPassword] = useState("");
	const [configCredentialError, setConfigCredentialError] = useState<string | null>(
		null,
	);
	const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
	const [tablePreviewPage, setTablePreviewPage] = useState(0);
	const [tableSearchInput, setTableSearchInput] = useState("");
	const deferredTableSearchInput = useDeferredValue(tableSearchInput);
	const [tableSort, setTableSort] = useState<TableSortState | null>(null);
	const [columnFilters, setColumnFilters] = useState<Record<string, string>>(
		{},
	);
	const [selectedRowIds, setSelectedRowIds] = useState<Record<string, boolean>>(
		{},
	);
	const [expandedSchemaKeys, setExpandedSchemaKeys] = useState<
		Record<string, boolean>
	>({});
	const [sql, setSql] = useState(POSTGRES_DEFAULT_SQL);
	const [formError, setFormError] = useState<string | null>(null);
	const [queryError, setQueryError] = useState<string | null>(null);
	const [tableActionError, setTableActionError] = useState<string | null>(null);
	const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
	const [isSqlDialogOpen, setIsSqlDialogOpen] = useState(false);
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isEditDialogLoading, setIsEditDialogLoading] = useState(false);
	const [isCellDetailDialogOpen, setIsCellDetailDialogOpen] = useState(false);
	const [isCellDetailLoading, setIsCellDetailLoading] = useState(false);
	const [isCreatingRow, setIsCreatingRow] = useState(false);
	const [tableExportFormat, setTableExportFormat] = useState<
		"csv" | "json" | null
	>(null);
	const [isCellDetailCopying, setIsCellDetailCopying] = useState(false);
	const [isCellDetailExporting, setIsCellDetailExporting] = useState(false);
	const [isCellContextMenuOpen, setIsCellContextMenuOpen] = useState(false);
	const [isSavingWorkspaceCredentials, setIsSavingWorkspaceCredentials] =
		useState(false);
	const [contextCell, setContextCell] = useState<ContextCellState | null>(null);
	const [pendingEditRequest, setPendingEditRequest] =
		useState<PendingEditRequest | null>(null);
	const [editingCell, setEditingCell] = useState<EditableCellState | null>(
		null,
	);
	const [rowDraft, setRowDraft] = useState<Record<string, RowDraftValue>>({});
	const [cellDetail, setCellDetail] = useState<CellDetailState | null>(null);
	const previewScrollRef = useRef<HTMLDivElement>(null);

	const labelInputRef = useRef<HTMLInputElement>(null);
	const groupInputRef = useRef<HTMLInputElement>(null);
	const pathInputRef = useRef<HTMLInputElement>(null);
	const postgresHostRef = useRef<HTMLInputElement>(null);
	const postgresPortRef = useRef<HTMLInputElement>(null);
	const postgresUsernameRef = useRef<HTMLInputElement>(null);
	const postgresPasswordRef = useRef<HTMLInputElement>(null);
	const postgresDatabaseRef = useRef<HTMLInputElement>(null);
	const previousActiveConnectionIdRef = useRef<string | null>(null);

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

		previousActiveConnectionIdRef.current = resolvedSelectedConnectionId;
		setQueryError(null);
		setTableActionError(null);
		setQueryResult(null);
		setSelectedTableKey(null);
		setTablePreviewPage(0);
		setTableSearchInput("");
		setTableSort(null);
		setColumnFilters({});
		setSelectedRowIds({});
	}, [resolvedSelectedConnectionId]);

	useEffect(() => {
		setSql(
			connectionType === "sqlite" ? SQLITE_DEFAULT_SQL : POSTGRES_DEFAULT_SQL,
		);
	}, [connectionType]);

	const discoverQuery = electronTrpc.databases.discoverWorkspaceDatabases.useQuery(
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

	const activePostgresConnectionInput = useMemo(
		() => getPostgresConnectionInput(activeConnection),
		[activeConnection],
	);

	const inspectPostgresQuery = electronTrpc.databases.inspectPostgres.useQuery(
		{
			connection:
				activePostgresConnectionInput ?? {
					kind: "connectionString",
					connectionString: "",
				},
		},
		{
			enabled:
				activeConnection?.dialect === "postgres" &&
				Boolean(activePostgresConnectionInput),
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
				setTableActionError(null);
				setTableSearchInput("");
				setTableSort(null);
				setColumnFilters({});
				setSelectedRowIds({});
			}
			return;
		}

		if (
			selectedTableKey &&
			!activeTables.some((table) => getTableKey(table) === selectedTableKey)
		) {
			setSelectedTableKey(null);
			setTableActionError(null);
			setTableSearchInput("");
			setTableSort(null);
			setColumnFilters({});
			setSelectedRowIds({});
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
			placeholderData: (previousData) => previousData,
		},
	);

	const previewPostgresQuery =
			electronTrpc.databases.previewPostgresTable.useQuery(
				{
					connection:
						activePostgresConnectionInput ?? {
							kind: "connectionString",
							connectionString: "",
						},
					schema: selectedTable?.schema ?? "public",
					tableName: selectedTable?.name ?? "",
					limit: TABLE_PREVIEW_PAGE_SIZE,
				offset: tablePreviewPage * TABLE_PREVIEW_PAGE_SIZE,
			},
				{
					enabled:
						activeConnection?.dialect === "postgres" &&
						Boolean(activePostgresConnectionInput) &&
						Boolean(selectedTable?.schema) &&
						Boolean(selectedTable?.name),
					placeholderData: (previousData) => previousData,
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
	const saveWorkspaceDatabaseCredentialsMutation =
		electronTrpc.databases.saveWorkspaceDatabaseCredentials.useMutation();

	const discoveredFiles = useMemo(() => {
		const connectedPaths = new Set(
			connections
				.filter((connection) => connection.dialect === "sqlite")
				.map((connection) => connection.databasePath)
				.filter((value): value is string => Boolean(value)),
		);
		const connectedWorkspaceDefinitions = new Set(
			connections
				.filter(
					(connection) =>
						connection.dialect === "postgres" &&
						connection.source === "workspace-config" &&
						connection.workspacePath &&
						connection.workspaceDefinitionId,
				)
				.map(
					(connection) =>
						`${connection.workspacePath}::${connection.workspaceDefinitionId}`,
				),
		);

		return ((discoverQuery.data?.items ?? []) as DiscoveredWorkspaceDatabaseItem[])
			.filter((item) => {
				if (item.dialect === "sqlite") {
					return !connectedPaths.has(item.absolutePath);
				}

				return !connectedWorkspaceDefinitions.has(
					`${worktreePath ?? ""}::${item.definitionId}`,
				);
			});
	}, [connections, discoverQuery.data?.items, worktreePath]);
	const activePreviewQuery =
		activeConnection?.dialect === "postgres"
			? previewPostgresQuery
			: previewSqliteQuery;
	const isQueryRunning =
		executeSQLiteMutation.isPending || executePostgresMutation.isPending;

	const visiblePreviewColumns = activePreviewQuery.data?.columns ?? [];
	const columnTypeByName = useMemo(
		() =>
			Object.fromEntries(
				(selectedTable?.columns ?? []).map((column) => [
					column.name,
					column.type,
				]),
			) as Record<string, string>,
		[selectedTable?.columns],
	);
	const selectedTableLabel = selectedTable
		? selectedTable.schema
			? `${selectedTable.schema}.${selectedTable.name}`
			: selectedTable.name
		: null;
	const previewRows = activePreviewQuery.data?.rows ?? [];
	const normalizedTableSearch = deferredTableSearchInput.trim().toLowerCase();
	const normalizedColumnFilters = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(columnFilters)
					.map(([column, value]) => [column, value.trim().toLowerCase()])
					.filter(([, value]) => value.length > 0),
			) as Record<string, string>,
		[columnFilters],
	);
	const filteredPreviewRows = useMemo(() => {
		const rows = [...previewRows];
		const hasGlobalSearch = normalizedTableSearch.length > 0;
		const filterEntries = Object.entries(normalizedColumnFilters);

		const nextRows = rows.filter((row) => {
			if (hasGlobalSearch) {
				const matchesGlobal = visiblePreviewColumns.some((column) =>
					matchesSearchValue(row[column], normalizedTableSearch),
				);
				if (!matchesGlobal) {
					return false;
				}
			}

			for (const [column, value] of filterEntries) {
				if (!matchesSearchValue(row[column], value)) {
					return false;
				}
			}

			return true;
		});

		if (!tableSort) {
			return nextRows;
		}

		return nextRows.sort((left, right) => {
			const comparison = comparePreviewValues(
				left[tableSort.column],
				right[tableSort.column],
			);
			return tableSort.direction === "asc" ? comparison : -comparison;
		});
	}, [
		previewRows,
		normalizedTableSearch,
		normalizedColumnFilters,
		visiblePreviewColumns,
		tableSort,
	]);
	const filteredPreviewRowIds = useMemo(
		() =>
			filteredPreviewRows
				.map((row) =>
					activeConnection
						? getRowIdentifier(row, activeConnection.dialect)
						: null,
				)
				.filter((value): value is string => Boolean(value)),
		[filteredPreviewRows, activeConnection],
	);
	const selectedVisibleRowCount = useMemo(
		() => filteredPreviewRowIds.filter((rowId) => selectedRowIds[rowId]).length,
		[filteredPreviewRowIds, selectedRowIds],
	);
	const areAllVisibleRowsSelected =
		filteredPreviewRowIds.length > 0 &&
		selectedVisibleRowCount === filteredPreviewRowIds.length;
	const isPartiallySelected =
		selectedVisibleRowCount > 0 &&
		selectedVisibleRowCount < filteredPreviewRowIds.length;
	const queryHistoryForActiveConnection = useMemo(
		() =>
			activeConnection
				? queryHistory.filter(
						(item) => item.connectionId === activeConnection.id,
					)
				: [],
		[activeConnection, queryHistory],
	);
	const getCanOpenDetail = useCallback(
		(column: string, value: unknown) =>
			supportsDetailViewer(columnTypeByName[column] ?? "", value),
		[columnTypeByName],
	);
	const rowVirtualizer = useVirtualizer({
		count: filteredPreviewRows.length,
		getScrollElement: () => previewScrollRef.current,
		estimateSize: () => TABLE_PREVIEW_ROW_HEIGHT,
		overscan: TABLE_PREVIEW_OVERSCAN,
		rangeExtractor: defaultRangeExtractor,
	});
	const virtualRows = rowVirtualizer.getVirtualItems();
	const paddingTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
	const paddingBottom =
		virtualRows.length > 0
			? rowVirtualizer.getTotalSize() -
				(virtualRows[virtualRows.length - 1]?.end ?? 0)
			: 0;

	useEffect(() => {
		if (!activeConnection) {
			setSelectedRowIds((current) =>
				Object.keys(current).length > 0 ? {} : current,
			);
			return;
		}

		const validRowIds = new Set(
			previewRows
				.map((row) => getRowIdentifier(row, activeConnection.dialect))
				.filter((value): value is string => Boolean(value)),
		);

		setSelectedRowIds((current) => {
			const nextEntries = Object.entries(current).filter(([rowId]) =>
				validRowIds.has(rowId),
			);
			if (nextEntries.length === Object.keys(current).length) {
				return current;
			}
			return Object.fromEntries(nextEntries);
		});
	}, [previewRows, activeConnection]);

	useEffect(() => {
		if (!selectedTableLabel) {
			setContextCell(null);
		}
	}, [selectedTableLabel]);

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
			activePostgresConnectionInput
		) {
			return await executePostgresMutation.mutateAsync({
				connection: activePostgresConnectionInput,
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

	const buildInsertStatement = (
		values: Record<string, unknown>,
		defaultSourceRow?: Record<string, unknown>,
	) => {
		if (!selectedTable || !activeConnection) {
			throw new Error("Select a table first.");
		}

		const entries = Object.entries(values).filter(([column, value]) => {
			if (value !== null && value !== undefined) {
				return true;
			}
			return defaultSourceRow ? defaultSourceRow[column] !== undefined : false;
		});

		if (!entries.length) {
			throw new Error("Enter at least one value to insert.");
		}

		const columns = entries.map(([column]) => quoteSqlIdentifier(column));
		const sqlValues = entries.map(([, value]) =>
			toSqlLiteral(value, activeConnection.dialect),
		);
		const tableReference =
			activeConnection.dialect === "sqlite"
				? quoteSqlIdentifier(selectedTable.name)
				: `${quoteSqlIdentifier(selectedTable.schema ?? "public")}.${quoteSqlIdentifier(selectedTable.name)}`;

		return `INSERT INTO ${tableReference} (${columns.join(", ")}) VALUES (${sqlValues.join(", ")})`;
	};

	const applyRowUpdate = async ({
		row,
		updates,
	}: {
		row: Record<string, unknown>;
		updates: Record<string, unknown>;
	}) => {
		setTableActionError(null);
		await runSqlStatement(buildUpdateStatement({ row, updates }));
		await activePreviewQuery.refetch();
	};

	const exportRows = async (
		rows: Array<Record<string, unknown>>,
		format: "csv" | "json",
	) => {
		if (!selectedTableLabel) {
			return;
		}

		const fileBaseName = selectedTableLabel.replaceAll(".", "_");
		const content =
			format === "json"
				? JSON.stringify(
						rows.map((row) =>
							Object.fromEntries(
								visiblePreviewColumns.map((column) => [column, row[column]]),
							),
						),
						null,
						2,
					)
				: [
						visiblePreviewColumns.map((column) => toCsvCell(column)).join(","),
						...rows.map((row) =>
							visiblePreviewColumns
								.map((column) => toCsvCell(row[column]))
								.join(","),
						),
					].join("\n");

		const blob = new Blob([content], {
			type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
		});
		try {
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = `${fileBaseName}.${format}`;
			anchor.click();
			URL.revokeObjectURL(objectUrl);
		} catch (error) {
			throw new Error(
				error instanceof Error ? error.message : "Failed to export table rows.",
			);
		}
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

	const attachWorkspaceConfigPostgresConnection = (
		item: Extract<DiscoveredWorkspaceDatabaseItem, { dialect: "postgres" }>,
	) => {
		if (!worktreePath) {
			setFormError("Open a workspace before attaching this database.");
			return;
		}

		addConnection({
			label: item.label,
			group: item.group,
			dialect: "postgres",
			source: "workspace-config",
			workspacePath: worktreePath,
			workspaceDefinitionId: item.definitionId,
			host: item.host,
			port: item.port,
			databaseName: item.database,
			ssl: item.ssl,
			usernameHint: item.usernameHint,
		});
	};

	const openWorkspaceCredentialPrompt = (
		item: Extract<DiscoveredWorkspaceDatabaseItem, { dialect: "postgres" }>,
	) => {
		setCredentialPromptTarget(item);
		setConfigUsername(item.usernameHint ?? "");
		setConfigPassword("");
		setConfigCredentialError(null);
		setIsCredentialPromptOpen(true);
	};

	const handleAttachDiscoveredFile = (
		absolutePath: string,
		options?: { label?: string; group?: string },
	) => {
			addConnection({
				label: options?.label ?? guessConnectionLabel(absolutePath),
				group: options?.group ?? (groupInput.trim() || undefined),
				dialect: "sqlite",
				databasePath: absolutePath,
			});
	};

	const handleAttachDiscoveredDatabase = (
		item: DiscoveredWorkspaceDatabaseItem,
	) => {
		if (item.dialect === "sqlite") {
			handleAttachDiscoveredFile(item.absolutePath, {
				label: item.source === "config" ? item.label : undefined,
				group: item.source === "config" ? item.group : undefined,
			});
			return;
		}

		if (item.hasSavedCredentials) {
			attachWorkspaceConfigPostgresConnection(item);
			return;
		}

		openWorkspaceCredentialPrompt(item);
	};

	const handleSaveWorkspaceCredentials = async () => {
		if (!credentialPromptTarget || !worktreePath) {
			return;
		}

		const nextUsername = configUsername.trim();
		if (!nextUsername) {
			setConfigCredentialError("Username is required.");
			return;
		}

		setIsSavingWorkspaceCredentials(true);
		setConfigCredentialError(null);
		try {
			await saveWorkspaceDatabaseCredentialsMutation.mutateAsync({
				worktreePath,
				definitionId: credentialPromptTarget.definitionId,
				username: nextUsername,
				password: configPassword,
			});
			await discoverQuery.refetch();
			attachWorkspaceConfigPostgresConnection(credentialPromptTarget);
			setIsCredentialPromptOpen(false);
			setCredentialPromptTarget(null);
			setConfigPassword("");
		} catch (error) {
			setConfigCredentialError(
				error instanceof Error
					? error.message
					: "Failed to save workspace database credentials.",
			);
		} finally {
			setIsSavingWorkspaceCredentials(false);
		}
	};

	const handleRunQuery = async () => {
		try {
			await runSqlStatement(sql);
			if (activeConnection) {
				addQueryHistoryItem({
					connectionId: activeConnection.id,
					sql,
				});
			}
		} catch (error) {
			setQueryResult(null);
			setQueryError(
				error instanceof Error ? error.message : "Failed to execute SQL.",
			);
		}
	};

	const handleCreateRow = async () => {
		const blankRow = Object.fromEntries(
			visiblePreviewColumns.map((column) => [column, null]),
		) as Record<string, unknown>;
		setIsCreatingRow(true);
		try {
			await handleOpenEditDialog(blankRow, visiblePreviewColumns[0], "insert");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to open row editor.";
			setTableActionError(message);
			toast.error(message);
		} finally {
			setIsCreatingRow(false);
		}
	};

	const fetchFullRow = useCallback(
		async (row: Record<string, unknown>) => {
			if (!activeConnection || !selectedTable) {
				return row;
			}

			if (activeConnection.dialect === "sqlite") {
				const detail = await trpcUtils.databases.getSqliteRowDetail.fetch({
					databasePath: activeConnection.databasePath ?? "",
					tableName: selectedTable.name,
					rowId:
						typeof row[SQLITE_ROW_ID_COLUMN] === "string" ||
						typeof row[SQLITE_ROW_ID_COLUMN] === "number"
							? (row[SQLITE_ROW_ID_COLUMN] as string | number)
							: undefined,
					primaryKey:
						typeof row[SQLITE_PRIMARY_KEY_COLUMN] === "string"
							? row[SQLITE_PRIMARY_KEY_COLUMN]
							: undefined,
				});
				return {
					...detail.row,
					[SQLITE_ROW_ID_COLUMN]: row[SQLITE_ROW_ID_COLUMN],
					[SQLITE_PRIMARY_KEY_COLUMN]: row[SQLITE_PRIMARY_KEY_COLUMN],
				};
			}

			const detail = await trpcUtils.databases.getPostgresRowDetail.fetch({
				connection:
					getPostgresConnectionInput(activeConnection) ?? {
						kind: "connectionString",
						connectionString: "",
					},
				schema: selectedTable.schema ?? "public",
				tableName: selectedTable.name,
				ctid: String(row[POSTGRES_ROW_ID_COLUMN] ?? ""),
			});
			return {
				...detail.row,
				[POSTGRES_ROW_ID_COLUMN]: row[POSTGRES_ROW_ID_COLUMN],
			};
		},
		[activeConnection, selectedTable, trpcUtils],
	);

	const handleOpenEditDialog = useCallback(
		async (
			row: Record<string, unknown>,
			initialColumn?: string,
			mode: EditableCellState["mode"] = "edit",
		) => {
			let sourceRow = row;
			if (mode !== "insert" && activeConnection && selectedTable) {
				setIsEditDialogLoading(true);
				try {
					sourceRow = await fetchFullRow(row);
				} finally {
					setIsEditDialogLoading(false);
				}
			}

			const nextDraft = Object.fromEntries(
				visiblePreviewColumns.map((column) => [
					column,
					{
						value: formatCellValue(sourceRow[column]),
						isNull: mode === "insert" ? true : sourceRow[column] === null,
					},
				]),
			) as Record<string, RowDraftValue>;

			if (initialColumn && nextDraft[initialColumn]) {
				nextDraft[initialColumn] = {
					value: formatCellValue(sourceRow[initialColumn]),
					isNull: mode === "insert" ? false : sourceRow[initialColumn] === null,
				};
			}

			setRowDraft(nextDraft);
			setEditingCell({
				mode,
				row: sourceRow,
				column: initialColumn ?? visiblePreviewColumns[0] ?? "",
				value: initialColumn ? sourceRow[initialColumn] : null,
			});
			setIsEditDialogOpen(true);
		},
		[visiblePreviewColumns, activeConnection, selectedTable, fetchFullRow],
	);

	useEffect(() => {
		if (!pendingEditRequest || isCellContextMenuOpen) {
			return;
		}

		void handleOpenEditDialog(
			pendingEditRequest.row,
			pendingEditRequest.column,
			pendingEditRequest.mode ?? "edit",
		);
		setPendingEditRequest(null);
	}, [pendingEditRequest, isCellContextMenuOpen, handleOpenEditDialog]);

	const handleSaveRowEdit = async () => {
		if (!editingCell) {
			return;
		}

		const nextValues = Object.fromEntries(
			Object.entries(rowDraft).map(([column, draft]) => [
				column,
				draft.isNull
					? null
					: normalizeDraftValue(draft.value, editingCell.row[column]),
			]),
		);

		try {
			if (editingCell.mode === "edit") {
				await applyRowUpdate({ row: editingCell.row, updates: nextValues });
			} else {
				setTableActionError(null);
				await runSqlStatement(
					buildInsertStatement(nextValues, editingCell.row),
				);
				await activePreviewQuery.refetch();
			}
			setIsEditDialogOpen(false);
			setEditingCell(null);
			setRowDraft({});
		} catch (error) {
			setTableActionError(
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
		try {
			await applyRowUpdate({ row, updates: { [column]: value } });
		} catch (error) {
			setTableActionError(
				error instanceof Error ? error.message : "Failed to update cell.",
			);
		}
	};

	const toggleTableSort = (column: string) => {
		setTableSort((current) => {
			if (!current || current.column !== column) {
				return { column, direction: "asc" };
			}
			if (current.direction === "asc") {
				return { column, direction: "desc" };
			}
			return null;
		});
	};

	const setColumnFilterValue = (column: string, value: string) => {
		setColumnFilters((current) => {
			const next = { ...current };
			if (value.trim().length === 0) {
				delete next[column];
			} else {
				next[column] = value;
			}
			return next;
		});
	};

	const toggleRowSelection = useCallback(
		(row: Record<string, unknown>, checked: boolean) => {
			if (!activeConnection) {
				return;
			}
			const rowId = getRowIdentifier(row, activeConnection.dialect);
			if (!rowId) {
				return;
			}
			setSelectedRowIds((current) => {
				if (checked) {
					return {
						...current,
						[rowId]: true,
					};
				}
				const next = { ...current };
				delete next[rowId];
				return next;
			});
		},
		[activeConnection],
	);

	const handleOpenCellContextMenu = useCallback(
		(row: Record<string, unknown>, column: string) => {
			const formattedValue = formatCellValue(row[column]);
			setContextCell({
				row,
				column,
				display: formattedValue,
				title: formattedValue,
			});
		},
		[],
	);

	const handleOpenCellDetail = useCallback(
		async (row: Record<string, unknown>, column: string) => {
			setIsCellDetailLoading(true);
			setIsCellDetailDialogOpen(true);
			try {
				const fullRow = await fetchFullRow(row);
				const value = fullRow[column];
				const columnType = columnTypeByName[column] ?? "";
				const format = canUseJsonDetailFormat(columnType, value)
					? "json"
					: "text";
				setCellDetail({
					row: fullRow,
					column,
					columnType,
					value,
					format,
					draft: formatCellDetailDraft(value, format),
				});
			} catch (error) {
				setTableActionError(
					error instanceof Error
						? error.message
						: "Failed to load full cell value.",
				);
				setIsCellDetailDialogOpen(false);
			} finally {
				setIsCellDetailLoading(false);
			}
		},
		[columnTypeByName, fetchFullRow],
	);

	const handleCellDetailFormatChange = (
		nextFormat: "text" | "json" | "markdown",
	) => {
		setCellDetail((current) =>
			current
				? {
						...current,
						format: nextFormat,
						draft: formatCellDetailDraft(current.value, nextFormat),
					}
				: current,
		);
	};

	const handleExportCellDetail = async () => {
		if (!cellDetail || !selectedTableLabel) {
			return;
		}

		setIsCellDetailExporting(true);
		try {
			const blob = new Blob([cellDetail.draft], {
				type:
					cellDetail.format === "json"
						? "application/json"
						: "text/plain;charset=utf-8",
			});
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = `${selectedTableLabel.replaceAll(".", "_")}_${cellDetail.column}.${cellDetail.format === "json" ? "json" : cellDetail.format === "markdown" ? "md" : "txt"}`;
			anchor.click();
			URL.revokeObjectURL(objectUrl);
			toast.success("セル内容をエクスポートしました。");
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to export detailed cell value.";
			setTableActionError(message);
			toast.error(message);
		} finally {
			setIsCellDetailExporting(false);
		}
	};

	const handleSaveCellDetail = async () => {
		if (!cellDetail) {
			return;
		}

		try {
			const nextValue =
				cellDetail.format === "json"
					? JSON.parse(cellDetail.draft)
					: cellDetail.draft;
			await handleQuickCellUpdate({
				row: cellDetail.row,
				column: cellDetail.column,
				value: nextValue,
			});
			setCellDetail((current) =>
				current
					? {
							...current,
							value: nextValue,
						}
					: current,
			);
			setIsCellDetailDialogOpen(false);
		} catch (error) {
			setTableActionError(
				error instanceof Error
					? error.message
					: "Failed to save detailed cell value.",
			);
		}
	};

	const handleCopyCellDetail = async () => {
		if (!cellDetail) {
			return;
		}

		setIsCellDetailCopying(true);
		try {
			await copyToClipboard(cellDetail.draft);
			toast.success("セル内容をコピーしました。");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to copy cell value.";
			setTableActionError(message);
			toast.error(message);
		} finally {
			setIsCellDetailCopying(false);
		}
	};

	const handleExportPreviewRows = async (format: "csv" | "json") => {
		setTableExportFormat(format);
		try {
			await exportRows(filteredPreviewRows, format);
			toast.success(
				format === "csv"
					? "CSV をエクスポートしました。"
					: "JSON をエクスポートしました。",
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to export rows.";
			setTableActionError(message);
			toast.error(message);
		} finally {
			setTableExportFormat(null);
		}
	};

	const toggleAllVisibleRows = (checked: boolean) => {
		setSelectedRowIds((current) => {
			if (checked) {
				const next = { ...current };
				for (const rowId of filteredPreviewRowIds) {
					next[rowId] = true;
				}
				return next;
			}
			const next = { ...current };
			for (const rowId of filteredPreviewRowIds) {
				delete next[rowId];
			}
			return next;
		});
	};

	const handleDeleteSelectedRows = async () => {
		if (!selectedTable || !activeConnection || selectedVisibleRowCount === 0) {
			return;
		}

		const rowsToDelete = filteredPreviewRows.filter((row) => {
			const rowId = getRowIdentifier(row, activeConnection.dialect);
			return rowId ? selectedRowIds[rowId] : false;
		});

		if (!rowsToDelete.length) {
			return;
		}

		const confirmed = window.confirm(
			`${rowsToDelete.length} 行を削除します。元に戻せません。続行しますか？`,
		);
		if (!confirmed) {
			return;
		}

		try {
			const deleteStatement =
				activeConnection.dialect === "sqlite"
					? `DELETE FROM ${quoteSqlIdentifier(selectedTable.name)} WHERE ${rowsToDelete
							.map((row) => buildSqliteRowSelector(row))
							.join(" OR ")}`
					: `DELETE FROM ${quoteSqlIdentifier(selectedTable.schema ?? "public")}.${quoteSqlIdentifier(selectedTable.name)} WHERE ${rowsToDelete
							.map((row) => buildPostgresRowSelector(row))
							.join(" OR ")}`;

			await runSqlStatement(deleteStatement);
			setTableActionError(null);
			setSelectedRowIds({});
			await activePreviewQuery.refetch();
		} catch (error) {
			setTableActionError(
				error instanceof Error ? error.message : "Failed to delete rows.",
			);
		}
	};

	const toggleSchemaGroup = (schemaKey: string) => {
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

			<Dialog
				open={isCredentialPromptOpen}
				onOpenChange={(nextOpen) => {
					setIsCredentialPromptOpen(nextOpen);
					if (!nextOpen) {
						setCredentialPromptTarget(null);
						setConfigCredentialError(null);
						setConfigPassword("");
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Workspace database credentials</DialogTitle>
						<DialogDescription>
							{credentialPromptTarget
								? `${credentialPromptTarget.label} に接続するための認証情報を一度だけ入力します。以降はローカルに暗号化して保存され、再入力は不要です。`
								: "Enter database credentials."}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-3">
						<div className="space-y-1">
							<Label htmlFor="workspace-db-username">ユーザー名</Label>
							<Input
								id="workspace-db-username"
								value={configUsername}
								onChange={(event) => {
									setConfigUsername(event.target.value);
									setConfigCredentialError(null);
								}}
								placeholder={credentialPromptTarget?.usernameHint ?? "postgres"}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="workspace-db-password">パスワード</Label>
							<Input
								id="workspace-db-password"
								type="password"
								value={configPassword}
								onChange={(event) => {
									setConfigPassword(event.target.value);
									setConfigCredentialError(null);
								}}
								placeholder="password"
							/>
						</div>

						{configCredentialError ? (
							<Alert variant="destructive">
								<AlertTitle>Save credentials failed</AlertTitle>
								<AlertDescription>{configCredentialError}</AlertDescription>
							</Alert>
						) : null}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setIsCredentialPromptOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							onClick={handleSaveWorkspaceCredentials}
							disabled={isSavingWorkspaceCredentials}
						>
							保存して Attach
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

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
											onEdit={
												connection.source === "workspace-config"
													? undefined
													: () => {
															populateConnectionForm(connection);
															setIsAddConnectionOpen(true);
														}
											}
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
									{discoverQuery.data?.items.length ?? 0}
								</Badge>
							</div>
							{discoveredFiles.length > 0 ? (
								<div className="space-y-2">
									{discoveredFiles.map((file) => (
										<div
											key={
												file.source === "config"
													? `${file.source}:${file.definitionId}`
													: file.absolutePath
											}
											className="flex items-center gap-2 rounded-md border p-2"
										>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{file.source === "config"
														? file.label
														: guessConnectionLabel(file.absolutePath)}
												</p>
												<p className="text-muted-foreground truncate font-mono text-[11px]">
													{file.dialect === "postgres"
														? `${file.host}/${file.database}`
														: file.relativePath}
												</p>
											</div>
											<Badge variant="outline">{file.dialect}</Badge>
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => handleAttachDiscoveredDatabase(file)}
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
																		startTransition(() => {
																			setSelectedTableKey(getTableKey(table));
																			setTablePreviewPage(0);
																			setTableActionError(null);
																			setTableSearchInput("");
																			setTableSort(null);
																			setColumnFilters({});
																			setSelectedRowIds({});
																		});
																		if (previewScrollRef.current) {
																			previewScrollRef.current.scrollTop = 0;
																		}
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
												onClick={() => void handleCreateRow()}
												disabled={!selectedTable || isCreatingRow}
											>
												{isCreatingRow ? (
													<LuRefreshCw className="mr-1.5 size-3.5 animate-spin" />
												) : (
													<LuPlus className="mr-1.5 size-3.5" />
												)}
												{isCreatingRow ? "開いています..." : "行を追加"}
											</Button>
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
												onClick={() => void handleExportPreviewRows("csv")}
												disabled={
													!filteredPreviewRows.length ||
													tableExportFormat !== null
												}
											>
												<LuExternalLink
													className={cn(
														"mr-1.5 size-3.5",
														tableExportFormat === "csv" && "animate-pulse",
													)}
												/>
												{tableExportFormat === "csv" ? "書き出し中..." : "CSV"}
											</Button>
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => void handleExportPreviewRows("json")}
												disabled={
													!filteredPreviewRows.length ||
													tableExportFormat !== null
												}
											>
												<LuExternalLink
													className={cn(
														"mr-1.5 size-3.5",
														tableExportFormat === "json" && "animate-pulse",
													)}
												/>
												{tableExportFormat === "json"
													? "書き出し中..."
													: "JSON"}
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
									) : activePreviewQuery.isLoading &&
										!activePreviewQuery.data ? (
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
											{tableActionError ? (
												<Alert variant="destructive">
													<AlertTitle>Action failed</AlertTitle>
													<AlertDescription>
														{tableActionError}
													</AlertDescription>
												</Alert>
											) : null}
											<div className="flex flex-wrap items-center gap-2">
												<div className="relative min-w-[18rem] flex-1">
													<LuSearch className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
													<Input
														value={tableSearchInput}
														onChange={(event) =>
															setTableSearchInput(event.target.value)
														}
														placeholder="検索結果"
														className="pl-9"
													/>
													{tableSearchInput ? (
														<button
															type="button"
															className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
															onClick={() => setTableSearchInput("")}
														>
															<LuX className="size-4" />
														</button>
													) : null}
												</div>
												<Button
													type="button"
													size="sm"
													variant="outline"
													onClick={() => void handleDeleteSelectedRows()}
													disabled={
														selectedVisibleRowCount === 0 || isQueryRunning
													}
												>
													<LuTrash2 className="mr-1.5 size-3.5" />
													削除
													{selectedVisibleRowCount > 0
														? ` (${selectedVisibleRowCount})`
														: ""}
												</Button>
											</div>
											<div className="flex items-center gap-2 text-xs">
												<Badge variant="outline">
													{filteredPreviewRows.length} rows shown
												</Badge>
												<Badge variant="outline">
													{activePreviewQuery.data.elapsedMs} ms
												</Badge>
												<Badge variant="outline">
													{filteredPreviewRows.length > 0
														? `${activePreviewQuery.data.offset + 1}-${
																activePreviewQuery.data.offset +
																filteredPreviewRows.length
															}`
														: "0 rows"}
												</Badge>
												{selectedVisibleRowCount > 0 ? (
													<Badge variant="secondary">
														{selectedVisibleRowCount} selected
													</Badge>
												) : null}
												{activePreviewQuery.data.hasMore ? (
													<Badge variant="outline">more available</Badge>
												) : null}
												{activePreviewQuery.isFetching ? (
													<Badge variant="secondary">
														<LuRefreshCw className="mr-1 size-3 animate-spin" />
														Updating...
													</Badge>
												) : null}
											</div>
											<ContextMenu onOpenChange={setIsCellContextMenuOpen}>
												<ContextMenuTrigger asChild>
													<div className="overflow-hidden rounded-md border">
														<div
															ref={previewScrollRef}
															className="max-h-[42rem] overflow-auto"
														>
															<Table className="min-w-max">
																<TableHeader>
																	<TableRow>
																		<TableHead className="w-10 min-w-10">
																			<Checkbox
																				checked={
																					areAllVisibleRowsSelected
																						? true
																						: isPartiallySelected
																							? "indeterminate"
																							: false
																				}
																				onCheckedChange={(checked) =>
																					toggleAllVisibleRows(Boolean(checked))
																				}
																				aria-label="Select all visible rows"
																			/>
																		</TableHead>
																		{activePreviewQuery.data.columns.map(
																			(column) => (
																				<TableHead
																					key={column}
																					className="whitespace-nowrap"
																				>
																					<div className="flex items-center gap-1">
																						<button
																							type="button"
																							className="hover:text-foreground flex items-center gap-1 font-medium"
																							onClick={() =>
																								toggleTableSort(column)
																							}
																						>
																							<span>{column}</span>
																							{tableSort?.column === column ? (
																								tableSort.direction ===
																								"asc" ? (
																									<LuArrowUp className="size-3.5" />
																								) : (
																									<LuArrowDown className="size-3.5" />
																								)
																							) : (
																								<LuArrowUpDown className="text-muted-foreground size-3.5" />
																							)}
																						</button>
																						<Popover>
																							<PopoverTrigger asChild>
																								<Button
																									type="button"
																									size="icon"
																									variant="ghost"
																									className={cn(
																										"size-6",
																										columnFilters[column] &&
																											"text-primary",
																									)}
																								>
																									<LuFilter className="size-3.5" />
																								</Button>
																							</PopoverTrigger>
																							<PopoverContent
																								align="start"
																								className="w-72 space-y-3"
																							>
																								<div className="space-y-1">
																									<p className="text-sm font-medium">
																										フィルター条件 "{column}"
																									</p>
																									<Input
																										value={
																											columnFilters[column] ??
																											""
																										}
																										onChange={(event) =>
																											setColumnFilterValue(
																												column,
																												event.target.value,
																											)
																										}
																										placeholder="部分一致で絞り込み"
																									/>
																								</div>
																								<div className="flex items-center justify-end gap-2">
																									<Button
																										type="button"
																										size="sm"
																										variant="outline"
																										onClick={() =>
																											setColumnFilterValue(
																												column,
																												"",
																											)
																										}
																									>
																										Clear
																									</Button>
																								</div>
																							</PopoverContent>
																						</Popover>
																					</div>
																				</TableHead>
																			),
																		)}
																	</TableRow>
																</TableHeader>
																<TableBody>
																	{paddingTop > 0 ? (
																		<TableRow>
																			<TableCell
																				colSpan={Math.max(
																					activePreviewQuery.data.columns
																						.length + 1,
																					1,
																				)}
																				style={{ height: paddingTop }}
																				className="p-0"
																			/>
																		</TableRow>
																	) : null}
																	{filteredPreviewRows.length > 0 ? (
																		virtualRows.map((virtualRow) => {
																			const row =
																				filteredPreviewRows[virtualRow.index];
																			const rowId = activeConnection
																				? getRowIdentifier(
																						row,
																						activeConnection.dialect,
																					)
																				: null;
																			return (
																				<PreviewTableRowView
																					key={
																						rowId ??
																						`${virtualRow.index}-${activePreviewQuery.data.columns.join("-")}`
																					}
																					row={row}
																					rowId={rowId}
																					columns={
																						activePreviewQuery.data.columns
																					}
																					selected={Boolean(
																						rowId && selectedRowIds[rowId],
																					)}
																					onToggleSelection={toggleRowSelection}
																					onOpenContextMenu={
																						handleOpenCellContextMenu
																					}
																					getCanOpenDetail={getCanOpenDetail}
																					onOpenDetail={handleOpenCellDetail}
																					dataIndex={virtualRow.index}
																				/>
																			);
																		})
																	) : (
																		<TableRow>
																			<TableCell
																				colSpan={Math.max(
																					activePreviewQuery.data.columns
																						.length + 1,
																					1,
																				)}
																				className="text-muted-foreground text-center text-sm"
																			>
																				{previewRows.length > 0
																					? "現在の検索条件に一致する行はありません。"
																					: "No rows found in this table."}
																			</TableCell>
																		</TableRow>
																	)}
																	{paddingBottom > 0 ? (
																		<TableRow>
																			<TableCell
																				colSpan={Math.max(
																					activePreviewQuery.data.columns
																						.length + 1,
																					1,
																				)}
																				style={{ height: paddingBottom }}
																				className="p-0"
																			/>
																		</TableRow>
																	) : null}
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
													<ContextMenuItem
														disabled={!contextCell}
														onSelect={() =>
															contextCell
																? (() => {
																		setPendingEditRequest({
																			row: contextCell.row,
																			mode: "duplicate",
																		});
																		setIsCellContextMenuOpen(false);
																	})()
																: undefined
														}
													>
														<LuPlus className="mr-2 size-4" />
														行を複製
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
													onClick={() => {
														setTablePreviewPage((page) =>
															Math.max(page - 1, 0),
														);
														if (previewScrollRef.current) {
															previewScrollRef.current.scrollTop = 0;
														}
													}}
													disabled={tablePreviewPage === 0}
												>
													前へ
												</Button>
												<Button
													type="button"
													size="sm"
													variant="outline"
													onClick={() => {
														setTablePreviewPage((page) => page + 1);
														if (previewScrollRef.current) {
															previewScrollRef.current.scrollTop = 0;
														}
													}}
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
					<div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)] gap-3">
						<div className="min-h-0 overflow-hidden rounded-md border">
							<div className="flex items-center justify-between border-b px-3 py-2">
								<div>
									<p className="text-sm font-medium">Query history</p>
									<p className="text-muted-foreground text-[11px]">
										接続ごとに最近の実行 SQL を保存します
									</p>
								</div>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() =>
										activeConnection
											? clearQueryHistoryForConnection(activeConnection.id)
											: undefined
									}
									disabled={
										!activeConnection || !queryHistoryForActiveConnection.length
									}
								>
									Clear
								</Button>
							</div>
							<div className="max-h-[34rem] overflow-y-auto p-2">
								{queryHistoryForActiveConnection.length ? (
									<div className="space-y-1">
										{queryHistoryForActiveConnection.map(
											(item: SavedDatabaseQueryHistoryItem) => (
												<div
													key={item.id}
													className="hover:bg-muted/50 rounded-md border p-2"
												>
													<button
														type="button"
														className="w-full text-left"
														onClick={() => setSql(item.sql)}
													>
														<p className="truncate font-mono text-[11px]">
															{item.sql.replaceAll(/\s+/g, " ").trim()}
														</p>
														<p className="text-muted-foreground mt-1 text-[10px]">
															{new Date(item.executedAt).toLocaleString()}
														</p>
													</button>
													<div className="mt-2 flex items-center justify-end gap-2">
														<Button
															type="button"
															size="sm"
															variant="ghost"
															onClick={() => setSql(item.sql)}
														>
															Load
														</Button>
														<Button
															type="button"
															size="sm"
															variant="ghost"
															onClick={() => removeQueryHistoryItem(item.id)}
														>
															<LuTrash2 className="size-3.5" />
														</Button>
													</div>
												</div>
											),
										)}
									</div>
								) : (
									<p className="text-muted-foreground text-sm">
										まだ履歴はありません。
									</p>
								)}
							</div>
						</div>
						<div className="flex min-h-0 flex-col gap-3">
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
														Run a query against the selected database
														connection.
													</EmptyDescription>
												</EmptyHeader>
											</EmptyContent>
										</Empty>
									)}
								</div>
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
					if (!open) {
						return;
					}
				}}
			>
				<DialogContent className="flex max-h-[85vh] !max-w-[72rem] flex-col overflow-hidden">
					<DialogHeader>
						<DialogTitle>
							{editingCell?.mode === "insert"
								? "Insert Row"
								: editingCell?.mode === "duplicate"
									? "Duplicate Row"
									: "Edit Row"}{" "}
							{selectedTableLabel ? `for "${selectedTableLabel}"` : ""}
						</DialogTitle>
						<DialogDescription>
							{editingCell?.mode === "edit"
								? "選択した行の各カラム値を編集します。"
								: "値を確認して新しい行を保存します。"}
						</DialogDescription>
					</DialogHeader>
					<div className="grid max-h-[60vh] grid-cols-2 gap-4 overflow-y-auto pr-1">
						{isEditDialogLoading ? (
							<p className="text-muted-foreground col-span-2 text-sm">
								Loading full row data...
							</p>
						) : editingCell ? (
							visiblePreviewColumns.map((column) => {
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
						) : null}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								setIsEditDialogOpen(false);
								setEditingCell(null);
								setRowDraft({});
							}}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							onClick={() => void handleSaveRowEdit()}
							disabled={isEditDialogLoading}
						>
							{editingCell?.mode === "edit" ? "更新" : "保存"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				open={isCellDetailDialogOpen}
				onOpenChange={(open) => {
					if (!open) {
						setIsCellDetailDialogOpen(false);
						setCellDetail(null);
					}
				}}
			>
				<DialogContent className="flex max-h-[85vh] !max-w-[72rem] flex-col overflow-hidden">
					<DialogHeader>
						<DialogTitle>データを編集</DialogTitle>
						<DialogDescription>
							{cellDetail?.column
								? `${cellDetail.column} の詳細値を表示・編集します。`
								: "セルの詳細値を表示します。"}
						</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
						<div className="flex items-center gap-2">
							<Select
								value={cellDetail?.format === "json" ? "json" : "text"}
								onValueChange={(value) =>
									handleCellDetailFormatChange(value as "text" | "json")
								}
								disabled={!cellDetail}
							>
								<SelectTrigger className="w-32">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="text">Text</SelectItem>
									{cellDetail &&
									canUseJsonDetailFormat(
										cellDetail.columnType,
										cellDetail.value,
									) ? (
										<SelectItem value="json">JSON</SelectItem>
									) : null}
								</SelectContent>
							</Select>
							{cellDetail &&
							canUseMarkdownDetailFormat(
								cellDetail.columnType,
								cellDetail.value,
							) ? (
								<Button
									type="button"
									size="sm"
									variant={
										cellDetail.format === "markdown" ? "default" : "outline"
									}
									onClick={() =>
										handleCellDetailFormatChange(
											cellDetail.format === "markdown" ? "text" : "markdown",
										)
									}
								>
									<LuEye className="mr-1.5 size-3.5" />
									{cellDetail.format === "markdown"
										? "テキスト編集に戻る"
										: "Markdownとして見る"}
								</Button>
							) : null}
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void handleCopyCellDetail()}
								disabled={!cellDetail || isCellDetailCopying}
							>
								<LuCopy className="mr-1.5 size-3.5" />
								{isCellDetailCopying ? "コピー中..." : "コピー"}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void handleExportCellDetail()}
								disabled={!cellDetail || isCellDetailExporting}
							>
								<LuExternalLink className="mr-1.5 size-3.5" />
								{isCellDetailExporting ? "書き出し中..." : "Export"}
							</Button>
						</div>
						<div className="min-h-0 flex-1 overflow-hidden rounded-md border">
							{isCellDetailLoading ? (
								<div className="flex h-full items-center justify-center">
									<p className="text-muted-foreground text-sm">
										Loading full cell value...
									</p>
								</div>
							) : cellDetail?.format === "markdown" ? (
								<div className="h-[31rem] min-h-[31rem] max-h-[78vh] overflow-y-auto p-3">
									<div className="min-h-full">
										<MarkdownRenderer
											content={cellDetail.draft}
											scrollable={false}
											className="!h-auto overflow-visible"
										/>
									</div>
								</div>
							) : (
								<textarea
									value={cellDetail?.draft ?? ""}
									onChange={(event) =>
										setCellDetail((current) =>
											current
												? { ...current, draft: event.target.value }
												: current,
										)
									}
									className="text-foreground placeholder:text-muted-foreground h-[31rem] min-h-[31rem] w-full resize-none overflow-auto border-0 bg-transparent px-3 py-2 font-mono text-[12px] outline-none"
								/>
							)}
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								setIsCellDetailDialogOpen(false);
								setCellDetail(null);
							}}
						>
							閉じる
						</Button>
						<Button
							type="button"
							onClick={() => void handleSaveCellDetail()}
							disabled={!cellDetail || isCellDetailLoading}
						>
							保存
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
