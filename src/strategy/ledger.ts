import { randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	formatCount,
	formatMoney,
	parseCount,
	parseMoney,
} from "../lib/fixed.js";
import {
	ALLOWLIST_TOKEN,
	ENFORCEMENT_BOUNDARY,
	PROTECTED_TOKEN,
	STRATEGY_CAPITAL,
} from "./boundary.js";
import { type BalancePrecision, quoteBuyReservation } from "./fees.js";

export type IntentState =
	| "submitting"
	| "unknown"
	| "acknowledged"
	| "reconciled"
	| "released";

export interface StrategyIntent {
	id: string;
	clientOrderId: string;
	owner: string;
	ticker: string;
	side: "yes" | "no";
	action: "buy" | "sell";
	count: string;
	price: string;
	reservedNotional: string;
	reservedEntryFee: string;
	reservedExitFee: string;
	state: IntentState;
	orderId?: string;
	ackFillCount?: string;
	ackRemaining?: string;
	bookedCount?: string;
	reason?: string;
}

export interface AccountSnapshot {
	complete: boolean;
	positions: Array<{ ticker: string; position_fp?: string }>;
}

export interface StrategyState {
	version: 1;
	armed: boolean;
	capital: string;
	cash: string;
	owner: string;
	allowlistToken: string;
	protectedTokens: string[];
	enforcement: string;
	intents: StrategyIntent[];
	appliedFillIds: string[];
	appliedSettlementKeys: string[];
}

export interface BeginIntentInput {
	clientOrderId: string;
	owner?: string;
	ticker: string;
	side: "yes" | "no";
	action: "buy" | "sell";
	count: string;
	price: string;
	feeType: string;
	feeMultiplier: string;
	balancePrecision: BalancePrecision;
	account: AccountSnapshot;
}

const EMPTY = (owner: string): StrategyState => ({
	version: 1,
	armed: false,
	capital: STRATEGY_CAPITAL,
	cash: STRATEGY_CAPITAL,
	owner,
	allowlistToken: ALLOWLIST_TOKEN,
	protectedTokens: [PROTECTED_TOKEN],
	enforcement: ENFORCEMENT_BOUNDARY,
	intents: [],
	appliedFillIds: [],
	appliedSettlementKeys: [],
});

async function withFileLock<T>(
	directory: string,
	fn: () => Promise<T>,
): Promise<T> {
	await mkdir(directory, { recursive: true });
	const lockPath = join(directory, "ledger.lock");
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}`);
			try {
				return await fn();
			} finally {
				await handle.close();
				await unlink(lockPath).catch(() => {});
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			await stealStaleLock(lockPath);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw new Error("Could not lock the strategy ledger.");
}

async function stealStaleLock(lockPath: string): Promise<void> {
	try {
		const raw = await readFile(lockPath, "utf8");
		const pid = Number(raw);
		if (!Number.isInteger(pid) || pid <= 0) {
			await unlink(lockPath);
			return;
		}
		try {
			process.kill(pid, 0);
		} catch {
			await unlink(lockPath);
		}
	} catch {
		// Another waiter removed it.
	}
}

export class StrategyLedger {
	constructor(
		private readonly directory: string,
		private readonly owner = "a1",
	) {}

	async status(): Promise<StrategyState> {
		return withFileLock(this.directory, () => this.read());
	}

	/** Offline tests only. The MCP server never calls this. */
	async armForOfflineTests(): Promise<void> {
		await withFileLock(this.directory, async () => {
			const state = await this.read();
			state.armed = true;
			await this.write(state);
		});
	}

	async getByClientOrderId(
		clientOrderId: string,
	): Promise<StrategyIntent | undefined> {
		const state = await this.status();
		return state.intents.find(
			(intent) => intent.clientOrderId === clientOrderId,
		);
	}

	async beginIntent(
		input: BeginIntentInput,
	): Promise<{ intent: StrategyIntent; created: boolean }> {
		return withFileLock(this.directory, async () => {
			const state = await this.read();
			const duplicate = state.intents.find(
				(intent) => intent.clientOrderId === input.clientOrderId,
			);
			if (duplicate) return { intent: duplicate, created: false };
			this.assertTradable(state, input);
			const quote =
				input.action === "buy"
					? quoteBuyReservation({
							count: input.count,
							price: input.price,
							multiplier: input.feeMultiplier,
							precision: input.balancePrecision,
							feeType: input.feeType,
						})
					: {
							notional: "0.000000",
							entryFee: quoteBuyReservation({
								count: input.count,
								price: input.price,
								multiplier: input.feeMultiplier,
								precision: input.balancePrecision,
								feeType: input.feeType,
							}).entryFee,
							exitFee: "0.000000",
							total: "0.000000",
						};
			const reserved =
				input.action === "buy"
					? parseMoney(quote.total)
					: parseMoney(quote.entryFee);
			if (reserved > this.freeUnits(state)) {
				throw new Error("Reservation exceeds the $5 strategy cash.");
			}
			const intent: StrategyIntent = {
				id: randomUUID(),
				clientOrderId: input.clientOrderId,
				owner: input.owner ?? state.owner,
				ticker: input.ticker,
				side: input.side,
				action: input.action,
				count: formatCount(parseCount(input.count)),
				price: formatMoney(parseMoney(input.price)),
				reservedNotional: input.action === "buy" ? quote.notional : "0.000000",
				reservedEntryFee: quote.entryFee,
				reservedExitFee: input.action === "buy" ? quote.exitFee : "0.000000",
				state: "submitting",
			};
			state.intents.push(intent);
			this.assertNonNegative(state);
			await this.write(state);
			return { intent, created: true };
		});
	}

	async markUnknown(intentId: string, reason: string): Promise<void> {
		await this.update(intentId, (intent) => {
			if (intent.state === "reconciled" || intent.state === "released") return;
			intent.state = "unknown";
			intent.reason = reason;
		});
	}

	async recordAck(
		intentId: string,
		ack: { orderId?: string; fillCount?: string; remainingCount?: string },
	): Promise<void> {
		await this.update(intentId, (intent, state) => {
			intent.state = "acknowledged";
			intent.orderId = ack.orderId;
			intent.ackFillCount = ack.fillCount;
			intent.ackRemaining = ack.remainingCount;
			if (
				ack.remainingCount === "0.00" &&
				ack.fillCount &&
				intent.action === "buy"
			) {
				const requested = parseCount(intent.count);
				const filled = parseCount(ack.fillCount);
				const unfilled = requested - filled;
				if (unfilled > 0n) {
					this.releasePortion(intent, unfilled, requested);
				}
			}
			this.assertNonNegative(state);
		});
	}

	async applyFill(fill: {
		fillId: string;
		orderId?: string;
		clientOrderId?: string;
		ticker: string;
		outcomeSide: "yes" | "no";
		count: string;
		price: string;
		fee: string;
		action: "buy" | "sell";
	}): Promise<void> {
		await withFileLock(this.directory, async () => {
			const state = await this.read();
			if (!state.armed) {
				throw new Error("A1 strategy is DISARMED.");
			}
			if (state.appliedFillIds.includes(fill.fillId)) return;
			if (!fill.fee) {
				throw new Error("Fill fee is UNKNOWN. Refusing to book zero.");
			}
			const intent = state.intents.find(
				(item) =>
					item.clientOrderId === fill.clientOrderId ||
					(fill.orderId !== undefined && item.orderId === fill.orderId),
			);
			if (!intent) {
				throw new Error("Fill does not match a strategy intent.");
			}
			const count = parseCount(fill.count);
			const notional = (parseMoney(fill.price) * count) / 100n;
			const fee = parseMoney(fill.fee);
			if (fill.action === "buy") {
				state.cash = formatMoney(parseMoney(state.cash) - notional - fee);
				this.releasePortion(intent, count, parseCount(intent.count), "entry");
			} else {
				state.cash = formatMoney(parseMoney(state.cash) + notional - fee);
				intent.reservedExitFee = "0.000000";
			}
			const previous = intent.bookedCount ? parseCount(intent.bookedCount) : 0n;
			intent.bookedCount = formatCount(previous + count);
			state.appliedFillIds.push(fill.fillId);
			intent.state = "reconciled";
			this.assertNonNegative(state);
			await this.write(state);
		});
	}

	async applySettlement(settlement: {
		key: string;
		ticker: string;
		revenueCents?: number;
	}): Promise<void> {
		await withFileLock(this.directory, async () => {
			const state = await this.read();
			if (!state.armed) throw new Error("A1 strategy is DISARMED.");
			if (settlement.ticker.includes(PROTECTED_TOKEN)) {
				throw new Error("Refusing to book a protected holding.");
			}
			if (state.appliedSettlementKeys.includes(settlement.key)) return;
			if (
				typeof settlement.revenueCents !== "number" ||
				!Number.isInteger(settlement.revenueCents)
			) {
				throw new Error(
					"Settlement revenue is UNKNOWN cents. Refusing to book zero.",
				);
			}
			const dollars = BigInt(settlement.revenueCents) * 10_000n;
			state.cash = formatMoney(parseMoney(state.cash) + dollars);
			state.appliedSettlementKeys.push(settlement.key);
			this.assertNonNegative(state);
			await this.write(state);
		});
	}

	async releaseIfAbsent(intentId: string, complete: boolean): Promise<void> {
		if (!complete) {
			throw new Error(
				"Incomplete read. Leaving the intent UNKNOWN and the reservation frozen.",
			);
		}
		await this.update(intentId, (intent, state) => {
			intent.state = "released";
			intent.reservedNotional = "0.000000";
			intent.reservedEntryFee = "0.000000";
			intent.reservedExitFee = "0.000000";
			intent.reason = "complete read found no order";
			this.assertNonNegative(state);
		});
	}

	freeCash(state: StrategyState): string {
		return formatMoney(this.freeUnits(state));
	}

	private async update(
		intentId: string,
		change: (intent: StrategyIntent, state: StrategyState) => void,
	): Promise<void> {
		await withFileLock(this.directory, async () => {
			const state = await this.read();
			const intent = state.intents.find((item) => item.id === intentId);
			if (!intent) throw new Error(`Unknown intent ${intentId}`);
			change(intent, state);
			await this.write(state);
		});
	}

	private assertTradable(state: StrategyState, input: BeginIntentInput): void {
		if (!state.armed) {
			throw new Error("A1 strategy is DISARMED.");
		}
		if (!input.account.complete) {
			throw new Error("Account read is incomplete. Refusing to reserve.");
		}
		const ticker = input.ticker.toUpperCase();
		if (ticker.includes(PROTECTED_TOKEN)) {
			throw new Error(
				"SENATEAK and other manual holdings are protected from this strategy.",
			);
		}
		if (!ticker.includes(state.allowlistToken)) {
			throw new Error(
				`Ticker is outside the ${state.allowlistToken} allowlist.`,
			);
		}
		for (const position of input.account.positions) {
			if (position.ticker.toUpperCase().includes(PROTECTED_TOKEN)) continue;
			if (!position.ticker.toUpperCase().includes(state.allowlistToken))
				continue;
			const signed = position.position_fp;
			if (!signed) {
				throw new Error("Allowlisted position size is UNKNOWN.");
			}
			const strategy = this.ownedCount(state, position.ticker);
			if (parseCount(signed) !== strategy) {
				throw new Error(
					"Preexisting or mixed ownership on an allowlisted ticker. Refusing to net manual contracts.",
				);
			}
		}
		const open = state.intents.some(
			(intent) =>
				intent.state === "submitting" ||
				intent.state === "unknown" ||
				intent.state === "acknowledged",
		);
		if (open) {
			throw new Error(
				"An unresolved intent is frozen. A repeat or flip waits until it reconciles.",
			);
		}
	}

	private ownedCount(state: StrategyState, ticker: string): bigint {
		return state.intents
			.filter(
				(intent) => intent.ticker === ticker && intent.state === "reconciled",
			)
			.reduce((sum, intent) => {
				const filled = intent.bookedCount ? parseCount(intent.bookedCount) : 0n;
				const signed =
					intent.side === "yes"
						? intent.action === "buy"
							? filled
							: -filled
						: intent.action === "buy"
							? -filled
							: filled;
				return sum + signed;
			}, 0n);
	}

	private releasePortion(
		intent: StrategyIntent,
		part: bigint,
		whole: bigint,
		which: "all" | "entry" = "all",
	): void {
		if (whole <= 0n || part <= 0n) return;
		const scale = (value: string) => (parseMoney(value) * part) / whole;
		if (which === "all" || which === "entry") {
			intent.reservedNotional = formatMoney(
				parseMoney(intent.reservedNotional) - scale(intent.reservedNotional),
			);
			intent.reservedEntryFee = formatMoney(
				parseMoney(intent.reservedEntryFee) - scale(intent.reservedEntryFee),
			);
		}
		if (which === "all") {
			intent.reservedExitFee = formatMoney(
				parseMoney(intent.reservedExitFee) - scale(intent.reservedExitFee),
			);
		}
	}

	private freeUnits(state: StrategyState): bigint {
		return parseMoney(state.cash) - this.reservedUnits(state);
	}

	private reservedUnits(state: StrategyState): bigint {
		return state.intents.reduce((sum, intent) => {
			if (intent.state === "released") return sum;
			return (
				sum +
				parseMoney(intent.reservedNotional) +
				parseMoney(intent.reservedEntryFee) +
				parseMoney(intent.reservedExitFee)
			);
		}, 0n);
	}

	private assertNonNegative(state: StrategyState): void {
		if (parseMoney(state.cash) < 0n || this.freeUnits(state) < 0n) {
			throw new Error("Strategy cash or free balance would be negative.");
		}
	}

	private async read(): Promise<StrategyState> {
		try {
			const raw = await readFile(join(this.directory, "ledger.json"), "utf8");
			return JSON.parse(raw) as StrategyState;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw error;
			return EMPTY(this.owner);
		}
	}

	private async write(state: StrategyState): Promise<void> {
		const target = join(this.directory, "ledger.json");
		const temporary = `${target}.tmp`;
		await writeFile(temporary, JSON.stringify(state));
		const handle = await open(temporary, "r+");
		await handle.sync();
		await handle.close();
		await rename(temporary, target);
	}
}

export async function executeOnce(
	ledger: StrategyLedger,
	input: BeginIntentInput,
	submit: () => Promise<{
		orderId?: string;
		fillCount?: string;
		remainingCount?: string;
	}>,
): Promise<{ submitted: boolean; intent: StrategyIntent }> {
	const started = await ledger.beginIntent(input);
	if (!started.created) {
		return { submitted: false, intent: started.intent };
	}
	try {
		const ack = await submit();
		await ledger.recordAck(started.intent.id, ack);
		const updated = await ledger.getByClientOrderId(input.clientOrderId);
		return { submitted: true, intent: updated ?? started.intent };
	} catch (error) {
		await ledger.markUnknown(
			started.intent.id,
			error instanceof Error ? error.message : String(error),
		);
		throw error;
	}
}
