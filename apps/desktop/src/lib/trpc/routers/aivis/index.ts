import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
	AivisApiError,
	AivisApiKeyMissingError,
	aivisFetch,
	aivisJson,
} from "main/lib/aivis/client";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const WORD_TYPES = [
	"PROPER_NOUN",
	"COMMON_NOUN",
	"VERB",
	"ADJECTIVE",
	"SUFFIX",
] as const;

function wrapApiError(err: unknown): TRPCError {
	if (err instanceof AivisApiKeyMissingError) {
		return new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Aivis API key is not configured",
		});
	}
	if (err instanceof AivisApiError) {
		return new TRPCError({
			code: err.status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST",
			message: err.message,
		});
	}
	return new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: err instanceof Error ? err.message : String(err),
	});
}

const wordSchema = z.object({
	uuid: z.string().uuid(),
	surface: z.array(z.string().min(1)).min(1),
	pronunciation: z.array(z.string().min(1)).min(1),
	accent_type: z.array(z.number().int().min(0)),
	word_type: z.enum(WORD_TYPES).default("PROPER_NOUN"),
	priority: z.number().int().min(0).max(10).default(5),
});

interface DictionaryListItem {
	uuid: string;
	name: string;
	description: string;
	word_count: number;
	created_at: string;
	updated_at: string;
}

interface DictionaryDetail {
	name: string;
	description: string;
	word_properties: Array<{
		uuid: string;
		surface: string[];
		normalized_surface?: string[] | null;
		pronunciation: string[];
		accent_type: number[];
		word_type: (typeof WORD_TYPES)[number];
		priority: number;
	}>;
	created_at: string;
	updated_at: string;
}

interface UsageSummary {
	api_key_id: string;
	api_key_name: string;
	summary_date: string;
	summary_hour: number;
	request_count: number;
	character_count: number;
	credit_consumed: number;
}

interface UserMeResponse {
	handle?: string;
	name?: string;
	email?: string;
	credit_balance?: number;
	// Additional fields are ignored; we only surface balance + identity.
	[key: string]: unknown;
}

export const createAivisRouter = () => {
	return router({
		/** Validate the key without persisting it; returns basic user info. */
		validateKey: publicProcedure
			.input(z.object({ apiKey: z.string().min(1).optional() }))
			.mutation(async ({ input }) => {
				try {
					const me = await aivisJson<UserMeResponse>("/v1/users/me", {
						apiKey: input.apiKey ?? undefined,
					});
					return {
						ok: true as const,
						handle: typeof me.handle === "string" ? me.handle : null,
						name: typeof me.name === "string" ? me.name : null,
						creditBalance:
							typeof me.credit_balance === "number" ? me.credit_balance : null,
					};
				} catch (err) {
					if (err instanceof AivisApiKeyMissingError) {
						return { ok: false as const, reason: "missing" as const };
					}
					if (err instanceof AivisApiError) {
						return {
							ok: false as const,
							reason: err.status === 401 ? "unauthorized" : "api",
							message: err.message,
						} as const;
					}
					throw wrapApiError(err);
				}
			}),

		dictionary: router({
			list: publicProcedure.query(async () => {
				try {
					const json = await aivisJson<{
						user_dictionaries: DictionaryListItem[];
					}>("/v1/user-dictionaries");
					return json.user_dictionaries;
				} catch (err) {
					throw wrapApiError(err);
				}
			}),

			get: publicProcedure
				.input(z.object({ uuid: z.string().uuid() }))
				.query(async ({ input }) => {
					try {
						return await aivisJson<DictionaryDetail>(
							`/v1/user-dictionaries/${input.uuid}`,
						);
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			create: publicProcedure
				.input(
					z.object({
						name: z.string().min(1).max(100),
						description: z.string().max(500).default(""),
					}),
				)
				.mutation(async ({ input }) => {
					const uuid = randomUUID();
					try {
						await aivisFetch(`/v1/user-dictionaries/${uuid}`, {
							method: "PUT",
							json: {
								name: input.name,
								description: input.description,
								word_properties: [],
							},
						});
						return { uuid };
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			update: publicProcedure
				.input(
					z.object({
						uuid: z.string().uuid(),
						name: z.string().min(1).max(100),
						description: z.string().max(500).default(""),
						words: z.array(wordSchema),
					}),
				)
				.mutation(async ({ input }) => {
					try {
						await aivisFetch(`/v1/user-dictionaries/${input.uuid}`, {
							method: "PUT",
							json: {
								name: input.name,
								description: input.description,
								word_properties: input.words,
							},
						});
						return { success: true };
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			delete: publicProcedure
				.input(z.object({ uuid: z.string().uuid() }))
				.mutation(async ({ input }) => {
					try {
						await aivisFetch(`/v1/user-dictionaries/${input.uuid}`, {
							method: "DELETE",
						});
						return { success: true };
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			export: publicProcedure
				.input(z.object({ uuid: z.string().uuid() }))
				.query(async ({ input }) => {
					try {
						return await aivisJson<Record<string, unknown>>(
							`/v1/user-dictionaries/${input.uuid}/export`,
						);
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			import: publicProcedure
				.input(
					z.object({
						uuid: z.string().uuid(),
						data: z.record(z.string(), z.unknown()),
						override: z.boolean().default(false),
					}),
				)
				.mutation(async ({ input }) => {
					try {
						await aivisFetch(`/v1/user-dictionaries/${input.uuid}/import`, {
							method: "POST",
							query: { override: input.override },
							json: input.data,
						});
						return { success: true };
					} catch (err) {
						throw wrapApiError(err);
					}
				}),
		}),

		usage: router({
			daily: publicProcedure
				.input(
					z.object({
						startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
						endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
					}),
				)
				.query(async ({ input }) => {
					try {
						const json = await aivisJson<{ summaries: UsageSummary[] }>(
							"/v1/payment/usage-summaries",
							{
								query: {
									start_date: input.startDate,
									end_date: input.endDate,
								},
							},
						);

						const byDate = new Map<
							string,
							{
								date: string;
								requestCount: number;
								characterCount: number;
								creditConsumed: number;
								byApiKey: Record<
									string,
									{
										name: string;
										requestCount: number;
										characterCount: number;
										creditConsumed: number;
									}
								>;
							}
						>();

						for (const s of json.summaries) {
							const entry = byDate.get(s.summary_date) ?? {
								date: s.summary_date,
								requestCount: 0,
								characterCount: 0,
								creditConsumed: 0,
								byApiKey: {},
							};
							entry.requestCount += s.request_count;
							entry.characterCount += s.character_count;
							entry.creditConsumed += s.credit_consumed;

							const bucket = entry.byApiKey[s.api_key_id] ?? {
								name: s.api_key_name,
								requestCount: 0,
								characterCount: 0,
								creditConsumed: 0,
							};
							bucket.requestCount += s.request_count;
							bucket.characterCount += s.character_count;
							bucket.creditConsumed += s.credit_consumed;
							entry.byApiKey[s.api_key_id] = bucket;

							byDate.set(s.summary_date, entry);
						}

						const days = [...byDate.values()].sort((a, b) =>
							a.date.localeCompare(b.date),
						);
						const total = days.reduce(
							(acc, d) => ({
								requestCount: acc.requestCount + d.requestCount,
								characterCount: acc.characterCount + d.characterCount,
								creditConsumed: acc.creditConsumed + d.creditConsumed,
							}),
							{ requestCount: 0, characterCount: 0, creditConsumed: 0 },
						);

						return { days, total };
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			me: publicProcedure.query(async () => {
				try {
					const me = await aivisJson<UserMeResponse>("/v1/users/me");
					return {
						handle: typeof me.handle === "string" ? me.handle : null,
						name: typeof me.name === "string" ? me.name : null,
						creditBalance:
							typeof me.credit_balance === "number" ? me.credit_balance : null,
					};
				} catch (err) {
					throw wrapApiError(err);
				}
			}),
		}),

		model: router({
			get: publicProcedure
				.input(z.object({ uuid: z.string().uuid() }))
				.query(async ({ input }) => {
					try {
						const m = await aivisJson<AivmModelResponse>(
							`/v1/aivm-models/${input.uuid}`,
							{ optionalAuth: true },
						);
						return summarizeModel(m);
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			searchByName: publicProcedure
				.input(z.object({ name: z.string().min(1).max(100) }))
				.query(async ({ input }) => {
					try {
						const json = await aivisJson<{
							aivm_models: AivmModelResponse[];
						}>("/v1/aivm-models/search", {
							optionalAuth: true,
							query: { keyword: input.name, limit: 5 },
						});
						const models = json.aivm_models ?? [];
						const exact = models.find((m) => m.name === input.name);
						const match = exact ?? models[0];
						return match ? summarizeModel(match) : null;
					} catch (err) {
						throw wrapApiError(err);
					}
				}),

			resolveByNames: publicProcedure
				.input(z.object({ names: z.array(z.string().min(1).max(100)).max(50) }))
				.query(async ({ input }) => {
					const results = await Promise.all(
						input.names.map(async (name) => {
							try {
								const json = await aivisJson<{
									aivm_models: AivmModelResponse[];
								}>("/v1/aivm-models/search", {
									optionalAuth: true,
									query: { keyword: name, limit: 5 },
								});
								const models = json.aivm_models ?? [];
								const exact = models.find((m) => m.name === name);
								const match = exact ?? models[0];
								return match
									? { name, model: summarizeModel(match) }
									: { name, model: null };
							} catch {
								return { name, model: null };
							}
						}),
					);
					return results;
				}),
		}),
	});
};

interface AivmSpeaker {
	aivm_speaker_uuid: string;
	name: string;
	icon_url?: string | null;
}
interface AivmUser {
	handle?: string;
	name?: string;
	icon_url?: string | null;
}
interface AivmModelResponse {
	aivm_model_uuid: string;
	name: string;
	description?: string;
	user?: AivmUser;
	speakers?: AivmSpeaker[];
}

function summarizeModel(m: AivmModelResponse) {
	const speakerIcon = m.speakers?.[0]?.icon_url ?? null;
	const userIcon = m.user?.icon_url ?? null;
	return {
		uuid: m.aivm_model_uuid,
		name: m.name,
		description: m.description ?? "",
		iconUrl: speakerIcon ?? userIcon,
		authorName: m.user?.name ?? null,
		authorHandle: m.user?.handle ?? null,
	};
}
