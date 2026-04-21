declare module "bun:test" {
	export function afterEach(callback: () => void | Promise<void>): void;

	export function describe(
		name: string,
		callback: () => void | Promise<void>,
	): void;

	interface ItFn {
		(name: string, callback: () => void | Promise<void>): void;
		skip(name: string, callback: () => void | Promise<void>): void;
		skipIf(condition: boolean): (
			name: string,
			callback: () => void | Promise<void>,
		) => void;
	}

	export const it: ItFn;

	export function expect<T>(actual: T): {
		toContain(expected: unknown): void;
		toEqual(expected: unknown): void;
		toHaveLength(expected: number): void;
		toBeNull(): void;
		toBeTruthy(): void;
		toBeGreaterThan(expected: number): void;
	};
}
