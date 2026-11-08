export interface Page<T> {
	items: T[];
	cursor: string | null;
}

export type ReadStatus =
	| "complete"
	| "partial"
	| "empty"
	| "truncated"
	| "error";

export interface ReadPage<T> {
	status: ReadStatus;
	cursor: string | null;
	terminal: boolean;
	watermark: string | null;
	pages: number;
	reason?: string;
	items: T[];
}

export class RateLimitedError extends Error {
	readonly status = 429;
	constructor(message = "429 rate limit") {
		super(message);
		this.name = "RateLimitedError";
	}
}

export function isRateLimited(error: unknown): boolean {
	if (error instanceof RateLimitedError) return true;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("429");
}

export async function paginateReads<T>(options: {
	fetchPage: (cursor: string | undefined) => Promise<Page<T>>;
	identity: (item: T) => string;
	maxPages?: number;
	maxReadRetries?: number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<ReadPage<T>> {
	const maxPages = options.maxPages ?? 20;
	const maxReadRetries = options.maxReadRetries ?? 2;
	const sleep = options.sleep ?? (async () => {});
	const items: T[] = [];
	const seenIds = new Set<string>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let pages = 0;
	let watermark: string | null = null;

	while (pages < maxPages) {
		let page: Page<T> | null = null;
		let attempt = 0;
		while (page === null) {
			try {
				page = await options.fetchPage(cursor);
			} catch (error) {
				if (isRateLimited(error) && attempt < maxReadRetries) {
					attempt += 1;
					await sleep(0);
					continue;
				}
				if (pages === 0) {
					return {
						status: "error",
						cursor: cursor ?? null,
						terminal: false,
						watermark: null,
						pages,
						reason: error instanceof Error ? error.message : String(error),
						items: [],
					};
				}
				return {
					status: "truncated",
					cursor: cursor ?? null,
					terminal: false,
					watermark,
					pages,
					reason: error instanceof Error ? error.message : String(error),
					items,
				};
			}
		}
		pages += 1;
		for (const item of page.items) {
			const id = options.identity(item);
			if (seenIds.has(id)) continue;
			seenIds.add(id);
			items.push(item);
		}
		if (!page.cursor) {
			return {
				status: items.length === 0 ? "empty" : "complete",
				cursor: null,
				terminal: true,
				watermark,
				pages,
				items,
			};
		}
		if (seenCursors.has(page.cursor) || page.cursor === cursor) {
			return {
				status: "truncated",
				cursor: page.cursor,
				terminal: false,
				watermark,
				pages,
				reason: "repeated cursor",
				items,
			};
		}
		seenCursors.add(page.cursor);
		watermark = page.cursor;
		cursor = page.cursor;
		if (pages >= maxPages) {
			return {
				status: "partial",
				cursor,
				terminal: false,
				watermark,
				pages,
				reason: "page limit",
				items,
			};
		}
	}
	return {
		status: "partial",
		cursor: cursor ?? null,
		terminal: false,
		watermark,
		pages,
		reason: "page limit",
		items,
	};
}
