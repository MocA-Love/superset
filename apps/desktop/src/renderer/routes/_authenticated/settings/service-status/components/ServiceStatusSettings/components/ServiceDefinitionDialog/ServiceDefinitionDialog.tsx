import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormLabel,
	FormMessage,
} from "@superset/ui/form";
import { Input } from "@superset/ui/input";
import { RadioGroup, RadioGroupItem } from "@superset/ui/radio-group";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { HiOutlineArrowUpTray, HiOutlineCheckCircle } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ServiceStatusIcon } from "renderer/lib/service-status/ServiceStatusIcon";
import { SIMPLE_ICON_OPTIONS } from "renderer/lib/service-status/simple-icons-map";
import type {
	ServiceStatusDefinition,
	ServiceStatusIconType,
} from "shared/service-status-types";
import { z } from "zod";

const iconTypeSchema = z.enum([
	"simple-icon",
	"favicon",
	"custom-url",
	"custom-file",
]);

const formSchema = z
	.object({
		label: z.string().trim().min(1, "ラベルを入力してください").max(80),
		statusUrl: z
			.string()
			.trim()
			.min(1, "ステータスページの URL を入力してください")
			.refine(
				(v) => /^https?:\/\//i.test(v),
				"http:// か https:// で始まる URL を入力してください",
			),
		apiUrl: z
			.string()
			.trim()
			.min(1, "API URL を入力してください")
			.refine(
				(v) => /^https?:\/\//i.test(v),
				"http:// か https:// で始まる URL を入力してください",
			),
		iconType: iconTypeSchema,
		iconValue: z.string().nullable(),
	})
	.refine((data) => data.iconType !== "simple-icon" || !!data.iconValue, {
		message: "アイコンを選択してください",
		path: ["iconValue"],
	})
	.refine(
		(data) =>
			data.iconType !== "custom-url" ||
			(data.iconValue != null && /^https?:\/\//i.test(data.iconValue)),
		{ message: "http(s) の画像 URL を入力してください", path: ["iconValue"] },
	)
	.refine((data) => data.iconType !== "custom-file" || !!data.iconValue, {
		message: "ファイルを選択してください",
		path: ["iconValue"],
	});

type FormValues = z.infer<typeof formSchema>;

export interface ServiceDefinitionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// null when creating, existing row when editing.
	target: ServiceStatusDefinition | null;
}

export function ServiceDefinitionDialog({
	open,
	onOpenChange,
	target,
}: ServiceDefinitionDialogProps) {
	const isEdit = Boolean(target);

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			label: "",
			statusUrl: "",
			apiUrl: "",
			iconType: "favicon",
			iconValue: null,
		},
	});

	// Re-hydrate whenever the dialog (re)opens for a different row so the
	// same dialog instance is reused for create and edit without stale state.
	useEffect(() => {
		if (!open) return;
		form.reset(
			target
				? {
						label: target.label,
						statusUrl: target.statusUrl,
						apiUrl: target.apiUrl,
						iconType: target.iconType,
						iconValue: target.iconValue,
					}
				: {
						label: "",
						statusUrl: "",
						apiUrl: "",
						iconType: "favicon",
						iconValue: null,
					},
		);
		setValidationState(null);
	}, [open, target, form]);

	const [validationState, setValidationState] = useState<
		{ ok: true; description: string } | { ok: false; error: string } | null
	>(null);
	const [isValidating, setIsValidating] = useState(false);
	const [isUploading, setIsUploading] = useState(false);

	// `validateApiUrl` is a read-only query; we trigger it imperatively on the
	// "接続確認" button via tRPC utils.fetch so the React Query cache still
	// dedupes repeated clicks with the same URL.
	const trpcUtils = electronTrpc.useUtils();
	const uploadIconMutation =
		electronTrpc.serviceStatus.uploadCustomIcon.useMutation();
	const createMutation =
		electronTrpc.serviceStatus.createDefinition.useMutation();
	const updateMutation =
		electronTrpc.serviceStatus.updateDefinition.useMutation();
	const selectImageFileMutation =
		electronTrpc.window.selectImageFile.useMutation();

	const iconType = form.watch("iconType");
	const iconValue = form.watch("iconValue");
	const statusUrl = form.watch("statusUrl");

	const onSubmit = async (values: FormValues): Promise<void> => {
		try {
			if (isEdit && target) {
				const replacedPath =
					target.iconType === "custom-file" &&
					target.iconValue !== values.iconValue
						? target.iconValue
						: null;
				await updateMutation.mutateAsync({
					id: target.id,
					label: values.label,
					statusUrl: values.statusUrl,
					apiUrl: values.apiUrl,
					iconType: values.iconType,
					iconValue: values.iconValue,
					deleteReplacedIconPath: replacedPath,
				});
				toast.success(`${values.label} を更新しました`);
			} else {
				await createMutation.mutateAsync(values);
				toast.success(`${values.label} を追加しました`);
			}
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			toast.error(`保存に失敗しました: ${message}`);
		}
	};

	const runValidation = async (): Promise<void> => {
		const apiUrl = form.getValues("apiUrl");
		if (!apiUrl) {
			setValidationState({ ok: false, error: "API URL を入力してください" });
			return;
		}
		setIsValidating(true);
		try {
			const result = await trpcUtils.serviceStatus.validateApiUrl.fetch({
				apiUrl,
			});
			setValidationState(result);
		} catch (error) {
			setValidationState({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setIsValidating(false);
		}
	};

	const pickFile = async (): Promise<void> => {
		setIsUploading(true);
		try {
			const selected = await selectImageFileMutation.mutateAsync();
			if (selected.canceled || !selected.dataUrl) return;
			const saved = await uploadIconMutation.mutateAsync({
				dataUrl: selected.dataUrl,
			});
			form.setValue("iconValue", saved.absolutePath, { shouldDirty: true });
		} catch (error) {
			toast.error(
				`アイコンのアップロードに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			setIsUploading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{isEdit ? "サービスを編集" : "サービスを追加"}
					</DialogTitle>
					<DialogDescription>
						Statuspage.io 互換 API (<code>/api/v2/status.json</code>)
						を公開している プロバイダを追加・編集できます。
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="label"
							render={({ field }) => (
								<div className="space-y-1.5">
									<FormLabel>ラベル</FormLabel>
									<FormControl>
										<Input {...field} placeholder="例: GitHub" />
									</FormControl>
									<FormMessage />
								</div>
							)}
						/>

						<FormField
							control={form.control}
							name="statusUrl"
							render={({ field }) => (
								<div className="space-y-1.5">
									<FormLabel>ステータスページ URL</FormLabel>
									<FormControl>
										<Input
											{...field}
											placeholder="https://www.githubstatus.com/"
										/>
									</FormControl>
									<FormMessage />
								</div>
							)}
						/>

						<FormField
							control={form.control}
							name="apiUrl"
							render={({ field }) => (
								<div className="space-y-1.5">
									<FormLabel>API URL (Statuspage v2)</FormLabel>
									<div className="flex items-center gap-2">
										<FormControl>
											<Input
												{...field}
												placeholder="https://www.githubstatus.com/api/v2/status.json"
											/>
										</FormControl>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={runValidation}
											disabled={isValidating}
										>
											{isValidating ? "確認中…" : "接続確認"}
										</Button>
									</div>
									{validationState && (
										<p
											className={cn(
												"text-xs",
												validationState.ok
													? "text-emerald-600 dark:text-emerald-400"
													: "text-destructive",
											)}
										>
											{validationState.ok
												? `OK: ${validationState.description || "ステータス取得成功"}`
												: `NG: ${validationState.error}`}
										</p>
									)}
									<FormMessage />
								</div>
							)}
						/>

						<FormField
							control={form.control}
							name="iconType"
							render={({ field }) => (
								<div className="space-y-2">
									<FormLabel>アイコン</FormLabel>
									<RadioGroup
										value={field.value}
										onValueChange={(value) => {
											field.onChange(value as ServiceStatusIconType);
											form.setValue("iconValue", null, { shouldDirty: true });
										}}
										className="grid grid-cols-2 gap-2"
									>
										<IconOption
											value="favicon"
											label="サイトの favicon を自動取得"
										/>
										<IconOption
											value="simple-icon"
											label="ブランドアイコンから選択"
										/>
										<IconOption value="custom-url" label="画像 URL を指定" />
										<IconOption
											value="custom-file"
											label="ローカル画像をアップロード"
										/>
									</RadioGroup>
								</div>
							)}
						/>

						{iconType === "simple-icon" && (
							<SimpleIconPicker
								value={iconValue}
								onChange={(slug) =>
									form.setValue("iconValue", slug, { shouldDirty: true })
								}
							/>
						)}

						{iconType === "custom-url" && (
							<FormField
								control={form.control}
								name="iconValue"
								render={({ field }) => (
									<div className="space-y-1.5">
										<FormLabel>画像 URL</FormLabel>
										<FormControl>
											<Input
												value={field.value ?? ""}
												onChange={(event) => field.onChange(event.target.value)}
												placeholder="https://example.com/logo.png"
											/>
										</FormControl>
										<FormMessage />
									</div>
								)}
							/>
						)}

						{iconType === "custom-file" && (
							<div className="space-y-1.5">
								<FormLabel>アップロード済みファイル</FormLabel>
								<div className="flex items-center gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={pickFile}
										disabled={isUploading}
									>
										<HiOutlineArrowUpTray className="mr-1.5 h-4 w-4" />
										{isUploading ? "アップロード中…" : "ファイルを選択"}
									</Button>
									{iconValue && (
										<span className="text-xs text-muted-foreground truncate max-w-[24rem]">
											{iconValue}
										</span>
									)}
								</div>
								<FormField
									control={form.control}
									name="iconValue"
									render={() => <FormMessage />}
								/>
							</div>
						)}

						{/* Live preview of the configured icon. */}
						{(iconType === "favicon" ||
							iconType === "simple-icon" ||
							iconType === "custom-url" ||
							iconType === "custom-file") && (
							<div className="flex items-center gap-2 rounded-md border px-3 py-2 bg-accent/30">
								<span className="text-xs text-muted-foreground">
									プレビュー
								</span>
								<ServiceStatusIcon
									source={{
										iconType,
										iconValue,
										statusUrl: statusUrl || "https://example.com",
										label: form.watch("label") || "Preview",
									}}
									className="size-5"
								/>
							</div>
						)}

						<DialogFooter className="pt-2">
							<Button
								type="button"
								variant="ghost"
								onClick={() => onOpenChange(false)}
							>
								キャンセル
							</Button>
							<Button
								type="submit"
								disabled={createMutation.isPending || updateMutation.isPending}
							>
								<HiOutlineCheckCircle className="mr-1.5 h-4 w-4" />
								{isEdit ? "更新" : "追加"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}

function IconOption({
	value,
	label,
}: {
	value: ServiceStatusIconType;
	label: string;
}) {
	return (
		<label
			htmlFor={`icon-type-${value}`}
			className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-accent/40 has-[:checked]:bg-accent has-[:checked]:border-primary/50"
		>
			<RadioGroupItem value={value} id={`icon-type-${value}`} />
			<span>{label}</span>
		</label>
	);
}

function SimpleIconPicker({
	value,
	onChange,
}: {
	value: string | null;
	onChange: (slug: string) => void;
}) {
	return (
		<div className="space-y-1.5">
			<FormLabel>ブランドアイコン</FormLabel>
			<div className="max-h-48 overflow-y-auto rounded-md border p-2 grid grid-cols-6 gap-1.5">
				{SIMPLE_ICON_OPTIONS.map(({ slug, label, Icon }) => (
					<button
						key={slug}
						type="button"
						onClick={() => onChange(slug)}
						aria-label={label}
						title={label}
						className={cn(
							"flex items-center justify-center size-10 rounded-md border transition-colors",
							value === slug
								? "bg-accent border-primary/50"
								: "hover:bg-accent/40",
						)}
					>
						<Icon className="size-5" />
					</button>
				))}
			</div>
			{value && (
				<p className="text-xs text-muted-foreground">
					選択中: <code>{value}</code>
				</p>
			)}
		</div>
	);
}
