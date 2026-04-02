import { CodeBlock } from "@superset/ui/ai-elements/code-block";
import { createShikiTheme } from "renderer/screens/main/components/WorkspaceView/utils/code-theme/shiki-theme";
import { useResolvedTheme } from "renderer/stores/theme";

interface InspectCodeBlockProps {
	code: string;
	language: "json";
}

export function InspectCodeBlock({ code, language }: InspectCodeBlockProps) {
	const activeTheme = useResolvedTheme();
	const theme = activeTheme ? createShikiTheme(activeTheme) : undefined;

	return (
		<CodeBlock
			className="rounded-none border-0 bg-transparent"
			code={code}
			language={language}
			lightTheme={theme}
			darkTheme={theme}
		/>
	);
}
