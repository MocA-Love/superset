import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { useEffect, useRef, useState } from "react";
import { HiPlay, HiStop } from "react-icons/hi2";
import { electronTrpcClient } from "renderer/lib/trpc-client";

interface PresetData {
	uuid: string;
	name: string;
	iconUrl: string | null;
	sampleUrl: string | null;
}

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdd: (preset: PresetData) => void;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AddModelPresetDialog({ open, onOpenChange, onAdd }: Props) {
	const [uuid, setUuid] = useState("");
	const [preview, setPreview] = useState<{
		uuid: string;
		name: string;
		iconUrl: string | null;
		sampleUrl: string | null;
		authorName: string | null;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [playing, setPlaying] = useState(false);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	useEffect(() => {
		return () => {
			audioRef.current?.pause();
			audioRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!open) {
			setUuid("");
			setPreview(null);
			setError(null);
			setLoading(false);
			setPlaying(false);
			audioRef.current?.pause();
			audioRef.current = null;
		}
	}, [open]);

	useEffect(() => {
		const trimmed = uuid.trim();
		if (!UUID_RE.test(trimmed)) {
			setPreview(null);
			setError(null);
			return;
		}
		let canceled = false;
		setLoading(true);
		setError(null);
		electronTrpcClient.aivis.model.get
			.query({ uuid: trimmed })
			.then((m) => {
				if (canceled) return;
				setPreview({
					uuid: m.uuid,
					name: m.name,
					iconUrl: m.iconUrl,
					sampleUrl: m.sampleUrl,
					authorName: m.authorName,
				});
			})
			.catch((err) => {
				if (canceled) return;
				setPreview(null);
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!canceled) setLoading(false);
			});
		return () => {
			canceled = true;
		};
	}, [uuid]);

	const handleAdd = () => {
		if (!preview) return;
		audioRef.current?.pause();
		onAdd({
			uuid: preview.uuid,
			name: preview.name,
			iconUrl: preview.iconUrl,
			sampleUrl: preview.sampleUrl,
		});
		onOpenChange(false);
	};

	const togglePlay = () => {
		if (!preview?.sampleUrl) return;
		if (playing) {
			audioRef.current?.pause();
			setPlaying(false);
			return;
		}
		const audio = new Audio(preview.sampleUrl);
		audioRef.current?.pause();
		audioRef.current = audio;
		audio.onended = () => setPlaying(false);
		audio.onerror = () => setPlaying(false);
		audio.play().catch(() => setPlaying(false));
		setPlaying(true);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>カスタムモデルを追加</DialogTitle>
					<DialogDescription>
						Aivis のモデル UUID を貼り付けてください。名前とアイコンを Aivis API
						から取得します。
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="custom-model-uuid">Model UUID</Label>
						<Input
							id="custom-model-uuid"
							value={uuid}
							onChange={(e) => setUuid(e.target.value)}
							placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
							autoFocus
						/>
					</div>

					{loading && (
						<div className="text-xs text-muted-foreground">取得中…</div>
					)}

					{error && <p className="text-sm text-destructive">{error}</p>}

					{preview && (
						<div className="rounded-md border bg-card p-3 flex items-center gap-3">
							{preview.iconUrl ? (
								<img
									src={preview.iconUrl}
									alt=""
									className="h-12 w-12 rounded-md object-cover"
								/>
							) : (
								<div className="h-12 w-12 rounded-md bg-muted flex items-center justify-center text-lg">
									🎙️
								</div>
							)}
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium truncate">
									{preview.name}
								</div>
								{preview.authorName && (
									<div className="text-xs text-muted-foreground truncate">
										by {preview.authorName}
									</div>
								)}
							</div>
							{preview.sampleUrl && (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={togglePlay}
								>
									{playing ? (
										<HiStop className="h-3.5 w-3.5" />
									) : (
										<HiPlay className="h-3.5 w-3.5" />
									)}
								</Button>
							)}
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						キャンセル
					</Button>
					<Button onClick={handleAdd} disabled={!preview || loading}>
						追加
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
