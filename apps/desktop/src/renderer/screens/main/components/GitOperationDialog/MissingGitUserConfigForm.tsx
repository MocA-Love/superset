import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface MissingGitUserConfigFormProps {
	initialName?: string | null;
	initialEmail?: string | null;
	/**
	 * Called with the saved values when the form successfully writes the
	 * global git config. Callers typically invoke the original commit
	 * retry from inside this handler so the commit runs immediately with
	 * the new identity.
	 */
	onSaved: (values: { name: string; email: string }) => void;
}

export function MissingGitUserConfigForm({
	initialName,
	initialEmail,
	onSaved,
}: MissingGitUserConfigFormProps) {
	const [name, setName] = useState(initialName ?? "");
	const [email, setEmail] = useState(initialEmail ?? "");
	const [validationError, setValidationError] = useState<string | null>(null);
	const utils = electronTrpc.useUtils();

	const setGlobalMutation =
		electronTrpc.settings.setGlobalGitUserConfig.useMutation({
			onSuccess: async (_result, variables) => {
				await utils.settings.getGitInfo.invalidate();
				toast.success("Git ユーザー設定を保存しました");
				onSaved(variables);
			},
			onError: (err) => {
				setValidationError(
					err instanceof Error ? err.message : "保存に失敗しました",
				);
			},
		});

	const handleSave = () => {
		const trimmedName = name.trim();
		const trimmedEmail = email.trim();
		if (!trimmedName) {
			setValidationError("Name を入力してください");
			return;
		}
		if (!trimmedEmail) {
			setValidationError("Email を入力してください");
			return;
		}
		setValidationError(null);
		setGlobalMutation.mutate({ name: trimmedName, email: trimmedEmail });
	};

	return (
		<div className="flex flex-col gap-3 rounded border border-border bg-muted/30 p-3">
			<div className="space-y-1">
				<Label htmlFor="git-user-name" className="text-xs font-medium">
					user.name
				</Label>
				<Input
					id="git-user-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Your Name"
					disabled={setGlobalMutation.isPending}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleSave();
						}
					}}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor="git-user-email" className="text-xs font-medium">
					user.email
				</Label>
				<Input
					id="git-user-email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					placeholder="you@example.com"
					disabled={setGlobalMutation.isPending}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleSave();
						}
					}}
				/>
			</div>
			{validationError && (
				<p className="text-[11px] text-destructive">{validationError}</p>
			)}
			<p className="text-[11px] text-muted-foreground">
				<code>git config --global</code> で保存されます。全てのリポジトリで共通
				の identity として使われます。
			</p>
			<div className="flex justify-end">
				<Button
					size="sm"
					onClick={handleSave}
					disabled={setGlobalMutation.isPending}
				>
					{setGlobalMutation.isPending ? "保存中..." : "保存して再試行"}
				</Button>
			</div>
		</div>
	);
}
