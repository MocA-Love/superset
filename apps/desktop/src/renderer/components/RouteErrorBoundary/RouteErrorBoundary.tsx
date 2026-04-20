import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { reportError } from "renderer/lib/report-error";

export interface RouteErrorBoundaryProps {
	children: ReactNode;
	/** Short identifier to tag the Sentry event (e.g. "settings", "workspace"). */
	routeName: string;
	/** Optional override for the fallback UI. */
	fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface RouteErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

/**
 * Subtree error boundary. Use for routes or large sections where a local
 * failure shouldn't take down the whole app.
 *
 * Forwards errors to Sentry with `route` and `component-stack` context so
 * crashes are attributable to the failing subtree.
 */
export class RouteErrorBoundary extends Component<
	RouteErrorBoundaryProps,
	RouteErrorBoundaryState
> {
	state: RouteErrorBoundaryState = { hasError: false, error: null };

	static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		console.error(
			`[route-error-boundary:${this.props.routeName}] caught:`,
			error,
			errorInfo,
		);
		reportError(error, {
			severity: "error",
			tags: { subsystem: "route-error-boundary", route: this.props.routeName },
			context: { componentStack: errorInfo.componentStack },
		});
	}

	private reset = () => {
		this.setState({ hasError: false, error: null });
	};

	render(): ReactNode {
		if (!this.state.hasError || !this.state.error) {
			return this.props.children;
		}

		if (this.props.fallback) {
			return this.props.fallback(this.state.error, this.reset);
		}

		return (
			<div className="flex h-full w-full items-center justify-center p-6">
				<div className="max-w-md text-center space-y-3">
					<h2 className="text-lg font-semibold">Something went wrong</h2>
					<p className="text-sm text-muted-foreground">
						This section crashed and was isolated to protect the rest of the
						app. The error has been reported.
					</p>
					<pre className="text-xs text-muted-foreground opacity-70 whitespace-pre-wrap text-left rounded bg-muted/50 p-3 max-h-40 overflow-auto">
						{this.state.error.message}
					</pre>
					<button
						type="button"
						onClick={this.reset}
						className="rounded bg-muted px-3 py-1.5 text-sm hover:bg-muted/80"
					>
						Try again
					</button>
				</div>
			</div>
		);
	}
}
