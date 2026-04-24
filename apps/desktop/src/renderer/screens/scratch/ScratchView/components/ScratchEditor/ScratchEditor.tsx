import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { CodeEditorAdapter } from "renderer/screens/main/components/WorkspaceView/ContentView/components";
import { CodeEditor } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor";
import { detectEditorLanguage } from "shared/language-registry";

interface ScratchEditorProps {
	absolutePath: string;
}

export function ScratchEditor({ absolutePath }: ScratchEditorProps) {
	const editorRef = useRef<CodeEditorAdapter | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	const { data, error, isLoading, refetch } =
		electronTrpc.scratch.readFile.useQuery(
			{ absolutePath },
			{ retry: false, refetchOnWindowFocus: false },
		);

	const writeMut = electronTrpc.scratch.writeFile.useMutation({
		onSuccess: (res) => {
			setSavedAt(res.mtimeMs);
		},
	});

	// Reset draft whenever the path or backing file content changes so the
	// editor re-hydrates with the latest disk state.
	useEffect(() => {
		if (data?.kind === "text") {
			setDraft(data.content);
		} else {
			setDraft(null);
		}
	}, [data]);

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				読み込み中…
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
				<div className="text-destructive">
					ファイルを開けませんでした: {error.message}
				</div>
				<button
					type="button"
					className="rounded border border-border px-3 py-1 text-muted-foreground hover:text-foreground"
					onClick={() => refetch()}
				>
					再試行
				</button>
			</div>
		);
	}

	if (!data) return null;

	if (data.kind === "too-large") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-muted-foreground text-sm">
				<div>ファイルサイズが大きすぎます</div>
				<div className="text-xs">
					{(data.size / 1024 / 1024).toFixed(1)} MB / 上限{" "}
					{(data.maxBytes / 1024 / 1024).toFixed(1)} MB
				</div>
			</div>
		);
	}

	const language = detectEditorLanguage(absolutePath);
	const hasChanges = draft !== null && data.content !== draft;

	return (
		<div className="relative flex h-full flex-col">
			<CodeEditor
				editorRef={editorRef}
				value={draft ?? data.content}
				language={language}
				onChange={(next) => setDraft(next)}
				onSave={() => {
					if (draft === null) return;
					writeMut.mutate({ absolutePath, content: draft });
				}}
				fillHeight
				searchMode="overlay"
			/>
			<div className="flex items-center justify-between border-border border-t bg-tertiary px-3 py-1 text-[11px] text-muted-foreground">
				<span className="truncate" title={absolutePath}>
					{absolutePath}
				</span>
				<span>
					{writeMut.isPending
						? "保存中…"
						: hasChanges
							? "未保存の変更あり (⌘S で保存)"
							: savedAt
								? "保存しました"
								: "Scratch モード · Git / Agent / Chat / Terminal は無効"}
				</span>
			</div>
		</div>
	);
}
