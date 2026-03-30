import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
} from "@superset/ui/card";
import { Input } from "@superset/ui/input";
import { useCallback, useState } from "react";
import {
	HiOutlineGlobeAlt,
	HiOutlinePuzzlePiece,
	HiOutlineTrash,
} from "react-icons/hi2";
import { LuLoaderCircle } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function ExtensionsSettings() {
	const [installInput, setInstallInput] = useState("");
	const [isInstalling, setIsInstalling] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const utils = electronTrpc.useUtils();
	const { data: extensions, isLoading } =
		electronTrpc.extensions.list.useQuery();

	const invalidateExtensionQueries = useCallback(() => {
		utils.extensions.list.invalidate();
		utils.extensions.listToolbarExtensions.invalidate();
	}, [utils]);

	const installMutation = electronTrpc.extensions.install.useMutation({
		onSuccess: () => {
			setInstallInput("");
			setError(null);
			invalidateExtensionQueries();
		},
		onError: (err) => {
			setError(err.message);
		},
		onSettled: () => {
			setIsInstalling(false);
		},
	});

	const uninstallMutation = electronTrpc.extensions.uninstall.useMutation({
		onSuccess: () => {
			invalidateExtensionQueries();
		},
	});

	const toggleMutation = electronTrpc.extensions.toggle.useMutation({
		onSuccess: () => {
			invalidateExtensionQueries();
		},
	});

	const handleInstall = useCallback(() => {
		if (!installInput.trim()) return;
		setIsInstalling(true);
		setError(null);
		installMutation.mutate({ input: installInput.trim() });
	}, [installInput, installMutation]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				handleInstall();
			}
		},
		[handleInstall],
	);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Browser Extensions</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Install Chrome extensions from the Chrome Web Store
				</p>
			</div>

			{/* Install form */}
			<Card className="mb-6">
				<CardHeader className="pb-3">
					<div className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50">
							<HiOutlineGlobeAlt className="size-5" />
						</div>
						<div className="flex-1">
							<span className="font-medium">Install from Chrome Web Store</span>
							<CardDescription className="mt-0.5">
								Paste a Chrome Web Store URL or extension ID
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent className="pt-0">
					<div className="flex gap-2">
						<Input
							value={installInput}
							onChange={(e) => {
								setInstallInput(e.target.value);
								setError(null);
							}}
							onKeyDown={handleKeyDown}
							placeholder="https://chromewebstore.google.com/detail/... or extension ID"
							className="flex-1"
							disabled={isInstalling}
						/>
						<Button
							onClick={handleInstall}
							disabled={isInstalling || !installInput.trim()}
							size="sm"
						>
							{isInstalling ? (
								<>
									<LuLoaderCircle className="size-4 animate-spin mr-1" />
									Installing...
								</>
							) : (
								"Install"
							)}
						</Button>
					</div>
					{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
				</CardContent>
			</Card>

			{/* Installed extensions list */}
			{isLoading ? (
				<div className="flex items-center justify-center py-8 text-muted-foreground">
					<LuLoaderCircle className="size-5 animate-spin mr-2" />
					Loading extensions...
				</div>
			) : extensions && extensions.length > 0 ? (
				<div className="grid gap-3">
					{extensions.map((ext) => (
						<Card key={ext.id}>
							<CardHeader className="pb-2">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
										<div className="flex size-10 items-center justify-center rounded-lg border bg-muted/50 shrink-0">
											<HiOutlinePuzzlePiece className="size-5" />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 flex-wrap">
												<span className="font-medium truncate">{ext.name}</span>
												<span className="text-xs text-muted-foreground shrink-0">
													v{ext.version}
												</span>
												<CompatibilityBadge level={ext.compatibility.level} />
											</div>
											{ext.description && (
												<CardDescription className="mt-0.5 line-clamp-1">
													{ext.description}
												</CardDescription>
											)}
										</div>
									</div>
									<div className="flex items-center gap-2 shrink-0 ml-3">
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												toggleMutation.mutate({
													extensionId: ext.id,
													enabled: !ext.enabled,
												})
											}
										>
											{ext.enabled ? "Disable" : "Enable"}
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											onClick={() =>
												uninstallMutation.mutate({
													extensionId: ext.id,
												})
											}
										>
											<HiOutlineTrash className="size-4 text-destructive" />
										</Button>
									</div>
								</div>
							</CardHeader>
							{ext.compatibility.issues.length > 0 && (
								<CardContent className="pt-0">
									<details className="text-xs">
										<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
											{ext.compatibility.issues.length} compatibility{" "}
											{ext.compatibility.issues.length === 1
												? "issue"
												: "issues"}
										</summary>
										<ul className="mt-2 space-y-1 text-muted-foreground">
											{ext.compatibility.issues.map((issue, i) => (
												<li
													key={`${ext.id}-issue-${i}`}
													className="flex items-start gap-1.5"
												>
													<span
														className={
															issue.severity === "error"
																? "text-destructive"
																: "text-yellow-500"
														}
													>
														{issue.severity === "error" ? "x" : "!"}
													</span>
													<span>{issue.message}</span>
												</li>
											))}
										</ul>
									</details>
								</CardContent>
							)}
						</Card>
					))}
				</div>
			) : (
				<div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
					<HiOutlinePuzzlePiece className="size-10 mb-3 opacity-30" />
					<p className="text-sm font-medium">No extensions installed</p>
					<p className="text-xs mt-1 max-w-sm">
						Install extensions from the Chrome Web Store using the form above.
						Not all extensions are compatible with Electron.
					</p>
				</div>
			)}
		</div>
	);
}

function CompatibilityBadge({ level }: { level: "full" | "partial" | "low" }) {
	switch (level) {
		case "full":
			return (
				<Badge variant="default" className="text-[10px] px-1.5 py-0">
					Compatible
				</Badge>
			);
		case "partial":
			return (
				<Badge variant="secondary" className="text-[10px] px-1.5 py-0">
					Partial
				</Badge>
			);
		case "low":
			return (
				<Badge variant="destructive" className="text-[10px] px-1.5 py-0">
					Low Compat
				</Badge>
			);
	}
}
