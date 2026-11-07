import assert from "node:assert/strict";
import axios, {
	type AxiosInstance,
	type AxiosResponse,
	type InternalAxiosRequestConfig,
} from "axios";

export const OFFLINE_BASE = "https://offline.invalid/trade-api/v2";

export interface CapturedRequest {
	url: string;
	method: string;
	data: unknown;
}

export function installOfflineTransport(
	handler: (request: CapturedRequest) => unknown | Promise<unknown>,
): { calls: CapturedRequest[]; http: AxiosInstance } {
	const calls: CapturedRequest[] = [];
	const http = axios.create({
		adapter: async (config: InternalAxiosRequestConfig) => {
			const url = String(config.url ?? "");
			assert.ok(
				url.startsWith(OFFLINE_BASE),
				`transport left the offline base: ${url}`,
			);
			const captured: CapturedRequest = {
				url,
				method: String(config.method ?? "").toUpperCase(),
				data: config.data,
			};
			calls.push(captured);
			const data = await handler(captured);
			const response = {
				data,
				status: 200,
				statusText: "OK",
				headers: {},
				config,
			} as AxiosResponse;
			return response;
		},
	});
	return { calls, http };
}

export function requestBody(request: CapturedRequest): Record<string, unknown> {
	if (typeof request.data === "string") {
		return JSON.parse(request.data) as Record<string, unknown>;
	}
	if (request.data && typeof request.data === "object") {
		return request.data as Record<string, unknown>;
	}
	return {};
}
