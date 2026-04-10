import { type ReactNode, useEffect, useState } from "react";
import { isTearoffWindow } from "renderer/hooks/useTearoffInit";
import { authClient, setAuthToken, setJwt } from "renderer/lib/auth-client";
import { SupersetLogo } from "renderer/routes/sign-in/components/SupersetLogo/SupersetLogo";
import { electronTrpc } from "../../lib/electron-trpc";

export function AuthProvider({ children }: { children: ReactNode }) {
	// Tearoff windows get their auth token synchronously via preload
	const syncAuthToken = window.App?.tearoffAuthToken ?? null;

	const [isHydrated, setIsHydrated] = useState(() => {
		// If we have a sync token, apply it immediately and mark as hydrated
		if (syncAuthToken?.token && syncAuthToken?.expiresAt) {
			const isExpired = new Date(syncAuthToken.expiresAt) < new Date();
			if (!isExpired) {
				setAuthToken(syncAuthToken.token);
				return true;
			}
		}
		return false;
	});
	const { refetch: refetchSession } = authClient.useSession();

	const { data: storedToken, isSuccess } =
		electronTrpc.auth.getStoredToken.useQuery(undefined, {
			enabled: !syncAuthToken,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		});

	// For tearoff windows with sync token, fetch session/JWT in background (non-blocking)
	useEffect(() => {
		if (!syncAuthToken?.token) return;
		let cancelled = false;
		async function backgroundHydrate() {
			try {
				await refetchSession();
			} catch (err) {
				console.warn("[AuthProvider] tearoff session refetch failed", err);
			}
			if (cancelled) return;
			try {
				const res = await authClient.token();
				if (res.data?.token) {
					setJwt(res.data.token);
				}
			} catch (err) {
				console.warn("[AuthProvider] tearoff JWT fetch failed", err);
			}
		}
		backgroundHydrate();
		return () => {
			cancelled = true;
		};
	}, [syncAuthToken, refetchSession]);

	useEffect(() => {
		if (!isSuccess || isHydrated) return;

		let cancelled = false;

		async function hydrate() {
			if (storedToken?.token && storedToken?.expiresAt) {
				const isExpired = new Date(storedToken.expiresAt) < new Date();
				if (!isExpired) {
					setAuthToken(storedToken.token);
					try {
						await refetchSession();
					} catch (err) {
						console.warn(
							"[AuthProvider] session refetch failed during hydration",
							err,
						);
					}
					try {
						const res = await authClient.token();
						if (res.data?.token) {
							setJwt(res.data.token);
						}
					} catch (err) {
						console.warn(
							"[AuthProvider] JWT fetch failed during hydration",
							err,
						);
					}
				}
			}
			if (!cancelled) {
				setIsHydrated(true);
			}
		}

		hydrate();
		return () => {
			cancelled = true;
		};
	}, [storedToken, isSuccess, isHydrated, refetchSession]);

	electronTrpc.auth.onTokenChanged.useSubscription(undefined, {
		onData: async (data) => {
			if (data?.token && data?.expiresAt) {
				setAuthToken(null);
				await authClient.signOut({ fetchOptions: { throw: false } });
				setAuthToken(data.token);
				try {
					await refetchSession();
				} catch (err) {
					console.warn(
						"[AuthProvider] session refetch failed after token change",
						err,
					);
				}
				setIsHydrated(true);
			} else if (data === null) {
				setAuthToken(null);
				setJwt(null);
				try {
					await refetchSession();
				} catch (err) {
					console.warn(
						"[AuthProvider] session refetch failed after token cleared",
						err,
					);
				}
			}
		},
	});

	useEffect(() => {
		if (!isHydrated) return;

		const refreshJwt = () =>
			authClient
				.token()
				.then((res) => {
					if (res.data?.token) {
						setJwt(res.data.token);
					}
				})
				.catch((err: unknown) => {
					console.warn("[AuthProvider] JWT refresh failed", err);
				});

		refreshJwt();
		const interval = setInterval(refreshJwt, 50 * 60 * 1000);
		return () => clearInterval(interval);
	}, [isHydrated]);

	if (!isHydrated && !isTearoffWindow()) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-background">
				<SupersetLogo className="h-8 w-auto animate-pulse opacity-80" />
			</div>
		);
	}

	return <>{children}</>;
}
