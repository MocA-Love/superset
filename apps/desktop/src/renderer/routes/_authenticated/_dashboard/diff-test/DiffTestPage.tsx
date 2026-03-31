import { useState } from "react";
import { CodeMirrorDiffViewer } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/FileViewerPane/components/CodeMirrorDiffViewer";
import { diffFixtureList } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/FileViewerPane/components/CodeMirrorDiffViewer/diff-test-fixtures";

export function DiffTestPage() {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const fixture = diffFixtureList[selectedIndex];

	return (
		<div className="flex h-full w-full flex-col bg-background text-foreground">
			{/* Header */}
			<div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
				<span className="text-sm font-semibold">Diff Viewer Test</span>
				<select
					className="rounded border border-border bg-background px-2 py-1 text-xs"
					value={selectedIndex}
					onChange={(e) => setSelectedIndex(Number(e.target.value))}
				>
					{diffFixtureList.map((f, i) => (
						<option key={f.label} value={i}>
							{f.label}
						</option>
					))}
				</select>
				<span className="text-xs text-muted-foreground">{fixture.description}</span>
			</div>

			{/* Diff viewer */}
			<div className="min-h-0 flex-1 overflow-auto">
				<CodeMirrorDiffViewer
					key={fixture.label}
					original={fixture.original}
					modified={fixture.modified}
					language={fixture.language}
					viewMode="side-by-side"
				/>
			</div>
		</div>
	);
}
