"use client";

import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	Fragment,
	type HTMLAttributes,
	useContext,
	useEffect,
	useState,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import {
	type BundledLanguage,
	codeToHast,
	type ShikiTransformer,
	type ThemeRegistrationAny,
} from "shiki";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type CodeBlockTheme = ThemeRegistrationAny;

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
	code: string;
	language: BundledLanguage;
	showLineNumbers?: boolean;
	lightTheme?: CodeBlockTheme;
	darkTheme?: CodeBlockTheme;
};

type CodeBlockContextType = {
	code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
	code: "",
});

export type HighlightedCode = Awaited<ReturnType<typeof codeToHast>>;

const lineNumberTransformer: ShikiTransformer = {
	name: "line-numbers",
	line(node, line) {
		node.children.unshift({
			type: "element",
			tagName: "span",
			properties: {
				className: [
					"shiki-line-number",
					"inline-block",
					"min-w-10",
					"mr-4",
					"text-right",
					"select-none",
					"text-muted-foreground",
				],
			},
			children: [{ type: "text", value: String(line) }],
		});
	},
};

function plainTextToHast(code: string) {
	return {
		type: "root",
		children: [
			{
				type: "element",
				tagName: "pre",
				properties: {},
				children: [
					{
						type: "element",
						tagName: "code",
						properties: {},
						children: [{ type: "text", value: code }],
					},
				],
			},
		],
	} satisfies HighlightedCode;
}

export async function highlightCode(
	code: string,
	language: BundledLanguage,
	showLineNumbers = false,
	options?: {
		lightTheme?: CodeBlockTheme;
		darkTheme?: CodeBlockTheme;
	},
): Promise<[HighlightedCode, HighlightedCode]> {
	const transformers: ShikiTransformer[] = showLineNumbers
		? [lineNumberTransformer]
		: [];

	try {
		return await Promise.all([
			codeToHast(code, {
				lang: language,
				theme: options?.lightTheme ?? "one-light",
				transformers,
			}),
			codeToHast(code, {
				lang: language,
				theme: options?.darkTheme ?? "one-dark-pro",
				transformers,
			}),
		]);
	} catch {
		if (language === ("text" as BundledLanguage)) {
			const plainText = plainTextToHast(code);
			return [plainText, plainText];
		}

		return highlightCode(code, "text" as BundledLanguage, showLineNumbers, {
			lightTheme: options?.lightTheme,
			darkTheme: options?.darkTheme,
		});
	}
}

export function renderHighlightedCode(root: HighlightedCode) {
	return toJsxRuntime(root, {
		Fragment,
		development: false,
		jsx,
		jsxs,
	});
}

export const CodeBlock = ({
	code,
	language,
	showLineNumbers = false,
	lightTheme,
	darkTheme,
	className,
	children,
	...props
}: CodeBlockProps) => {
	const [highlightedCode, setHighlightedCode] =
		useState<HighlightedCode | null>(null);
	const [darkHighlightedCode, setDarkHighlightedCode] =
		useState<HighlightedCode | null>(null);

	useEffect(() => {
		let cancelled = false;
		highlightCode(code, language, showLineNumbers, {
			lightTheme,
			darkTheme,
		}).then(([light, dark]) => {
			if (!cancelled) {
				setHighlightedCode(light);
				setDarkHighlightedCode(dark);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [code, language, showLineNumbers, lightTheme, darkTheme]);

	return (
		<CodeBlockContext.Provider value={{ code }}>
			<div
				className={cn(
					"group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
					className,
				)}
				{...props}
			>
				<div className="relative">
					<div className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm">
						{highlightedCode ? renderHighlightedCode(highlightedCode) : null}
					</div>
					<div className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm">
						{darkHighlightedCode
							? renderHighlightedCode(darkHighlightedCode)
							: null}
					</div>
					{children && (
						<div className="absolute top-2 right-2 flex items-center gap-2">
							{children}
						</div>
					)}
				</div>
			</div>
		</CodeBlockContext.Provider>
	);
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	onCopy?: () => void;
	onError?: (error: Error) => void;
	timeout?: number;
};

export const CodeBlockCopyButton = ({
	onCopy,
	onError,
	timeout = 2000,
	children,
	className,
	...props
}: CodeBlockCopyButtonProps) => {
	const [isCopied, setIsCopied] = useState(false);
	const { code } = useContext(CodeBlockContext);

	const copyToClipboard = async () => {
		if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
			onError?.(new Error("Clipboard API not available"));
			return;
		}

		try {
			await navigator.clipboard.writeText(code);
			setIsCopied(true);
			onCopy?.();
			setTimeout(() => setIsCopied(false), timeout);
		} catch (error) {
			onError?.(error as Error);
		}
	};

	return (
		<Button
			className={cn("shrink-0", className)}
			onClick={copyToClipboard}
			size="icon"
			variant="ghost"
			{...props}
		>
			{children ?? (
				<div className="relative h-3.5 w-3.5">
					<CopyIcon
						className={cn(
							"absolute inset-0 h-3.5 w-3.5 transition-[opacity,transform] duration-200 ease-out",
							isCopied ? "scale-50 opacity-0" : "scale-100 opacity-100",
						)}
					/>
					<CheckIcon
						className={cn(
							"absolute inset-0 h-3.5 w-3.5 transition-[opacity,transform] duration-200 ease-out",
							isCopied ? "scale-100 opacity-100" : "scale-50 opacity-0",
						)}
					/>
				</div>
			)}
		</Button>
	);
};
