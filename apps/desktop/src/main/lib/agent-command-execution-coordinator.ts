interface ClaimEntry {
	expiresAt: number;
}

const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;

export class AgentCommandExecutionCoordinator {
	private readonly claims = new Map<string, ClaimEntry>();

	constructor(private readonly defaultClaimTtlMs = DEFAULT_CLAIM_TTL_MS) {}

	claim(commandId: string, timeoutAt?: Date | string | null): boolean {
		this.pruneExpiredClaims();

		const existing = this.claims.get(commandId);
		if (existing && existing.expiresAt > Date.now()) {
			return false;
		}

		this.claims.set(commandId, {
			expiresAt: this.resolveExpiry(timeoutAt),
		});
		return true;
	}

	release(commandId: string): void {
		this.claims.delete(commandId);
	}

	isClaimed(commandId: string): boolean {
		this.pruneExpiredClaims();
		const entry = this.claims.get(commandId);
		return !!entry && entry.expiresAt > Date.now();
	}

	private pruneExpiredClaims(): void {
		const now = Date.now();
		for (const [commandId, entry] of this.claims.entries()) {
			if (entry.expiresAt <= now) {
				this.claims.delete(commandId);
			}
		}
	}

	private resolveExpiry(timeoutAt?: Date | string | null): number {
		const fallbackExpiry = Date.now() + this.defaultClaimTtlMs;
		const parsed =
			timeoutAt instanceof Date
				? timeoutAt.getTime()
				: typeof timeoutAt === "string"
					? Date.parse(timeoutAt)
					: Number.NaN;
		if (Number.isFinite(parsed)) {
			return Math.max(parsed, fallbackExpiry);
		}
		return fallbackExpiry;
	}
}

let coordinator: AgentCommandExecutionCoordinator | null = null;

export function getAgentCommandExecutionCoordinator(): AgentCommandExecutionCoordinator {
	if (!coordinator) {
		coordinator = new AgentCommandExecutionCoordinator();
	}
	return coordinator;
}
