import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@superset/ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@superset/ui/command";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPortal,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Spinner } from "@superset/ui/spinner";
import { cn } from "@superset/ui/utils";
import type { ReactNode } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";

export interface SearchDialogItem {
	id: string;
}

interface SearchDialogProps<TItem extends SearchDialogItem> {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	query: string;
	onQueryChange: (query: string) => void;
	queryPlaceholder: string;
	filtersOpen: boolean;
	onFiltersOpenChange: (open: boolean) => void;
	includePattern: string;
	onIncludePatternChange: (value: string) => void;
	excludePattern: string;
	onExcludePatternChange: (value: string) => void;
	emptyMessage: string;
	isLoading: boolean;
	results: TItem[];
	getItemValue: (item: TItem) => string;
	onSelectItem: (item: TItem) => void;
	renderItem: (item: TItem) => ReactNode;
	headerExtra?: ReactNode;
	preResultsSection?: ReactNode;
	hasPreResults?: boolean;
	/** Extra Tailwind classes for the DialogContent wrapper (size / position). */
	contentClassName?: string;
	/** Extra Tailwind classes for CommandList (controls result-area height). */
	listClassName?: string;
}

export function SearchDialog<TItem extends SearchDialogItem>({
	open,
	onOpenChange,
	title,
	description,
	query,
	onQueryChange,
	queryPlaceholder,
	filtersOpen,
	onFiltersOpenChange,
	includePattern,
	onIncludePatternChange,
	excludePattern,
	onExcludePatternChange,
	emptyMessage,
	isLoading,
	results,
	getItemValue,
	onSelectItem,
	renderItem,
	headerExtra,
	preResultsSection,
	hasPreResults,
	contentClassName,
	listClassName,
}: SearchDialogProps<TItem>) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange} modal>
			<DialogPortal>
				<DialogPrimitive.Overlay
					data-slot="dialog-overlay"
					className="fixed inset-0 z-50"
				/>
				<DialogPrimitive.Content
					data-slot="dialog-content"
					className={cn(
						"bg-background fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-lg border p-0 shadow-lg sm:max-w-lg",
						contentClassName,
					)}
				>
					<DialogHeader className="sr-only">
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<Command
						className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
						shouldFilter={false}
					>
						<div className="relative">
							<CommandInput
								placeholder={queryPlaceholder}
								value={query}
								onValueChange={onQueryChange}
								className="pr-9"
							/>
							<div className="pointer-events-none absolute top-2 right-2 z-10">
								{isLoading ? (
									<div className="pointer-events-none absolute top-1 right-8">
										<Spinner className="size-4 text-muted-foreground" />
									</div>
								) : null}
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7 pointer-events-auto"
									aria-label={filtersOpen ? "Hide Filters" : "Show Filters"}
									aria-expanded={filtersOpen}
									onClick={() => onFiltersOpenChange(!filtersOpen)}
								>
									{filtersOpen ? (
										<LuChevronDown className="size-4" />
									) : (
										<LuChevronRight className="size-4" />
									)}
								</Button>
							</div>
						</div>
						{filtersOpen ? (
							<div className="grid grid-cols-2 gap-2 border-b px-3 py-2">
								<Input
									value={includePattern}
									onChange={(event) =>
										onIncludePatternChange(event.target.value)
									}
									placeholder="files to include (glob)"
									className="h-8 text-xs"
								/>
								<Input
									value={excludePattern}
									onChange={(event) =>
										onExcludePatternChange(event.target.value)
									}
									placeholder="files to exclude (glob)"
									className="h-8 text-xs"
								/>
							</div>
						) : null}
						{headerExtra}
						<CommandList className={cn(listClassName)}>
							{query.trim().length > 0 &&
								!isLoading &&
								results.length === 0 &&
								!hasPreResults && <CommandEmpty>{emptyMessage}</CommandEmpty>}
							{preResultsSection}
							{results.map((item) => (
								<CommandItem
									key={item.id}
									value={getItemValue(item)}
									onSelect={() => onSelectItem(item)}
								>
									{renderItem(item)}
								</CommandItem>
							))}
						</CommandList>
					</Command>
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	);
}
