import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { cn } from "@superset/ui/utils";
import { LuFilter } from "react-icons/lu";

export type StatusFilterOption<T extends string> = {
	value: T;
	label: string;
};

type Props<T extends string> = {
	options: readonly StatusFilterOption<T>[];
	selected: ReadonlySet<T>;
	onChange: (next: Set<T>) => void;
	title?: string;
};

export function StatusFilterPopover<T extends string>({
	options,
	selected,
	onChange,
	title = "ステータスで絞り込み",
}: Props<T>) {
	const count = selected.size;

	const toggle = (value: T) => {
		const next = new Set(selected);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		onChange(next);
	};

	const clear = () => onChange(new Set<T>());

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className={cn(
						"h-8 gap-1 px-2 text-xs rounded-md shrink-0",
						count > 0 && "border-primary/60 text-primary",
					)}
					title={title}
				>
					<LuFilter className="size-3.5" />
					{count > 0 && (
						<span className="tabular-nums text-[10px]">{count}</span>
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuLabel className="text-xs">{title}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{options.map((opt) => (
					<DropdownMenuCheckboxItem
						key={opt.value}
						checked={selected.has(opt.value)}
						onSelect={(e) => {
							e.preventDefault();
							toggle(opt.value);
						}}
						className="text-xs"
					>
						{opt.label}
					</DropdownMenuCheckboxItem>
				))}
				{count > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault();
								clear();
							}}
							className="text-xs text-muted-foreground"
						>
							クリア
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
