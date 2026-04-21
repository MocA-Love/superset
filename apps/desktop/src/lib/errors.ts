export class SessionDisposedError extends Error {
	constructor() {
		super("TypeScript session disposed");
		this.name = "SessionDisposedError";
	}
}
