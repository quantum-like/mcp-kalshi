import type { CreateOrderV2Request } from "kalshi-typescript";
import { type GridLimitInput, prepareA1Limit } from "../orders/price-grid.js";
import {
	type BeginIntentInput,
	type StrategyLedger,
	executeOnce,
} from "./ledger.js";

export interface A1Ack {
	orderId?: string;
	fillCount?: string;
	remainingCount?: string;
}

/**
 * The only a1 function that may call a transport. The fresh tick grid is
 * checked first. The persistent intent reservation is next. `submit` runs
 * only after both succeed, and a disarmed ledger never reaches it.
 */
export async function submitA1StrategyOrder(args: {
	ledger: StrategyLedger;
	order: GridLimitInput;
	feeType: BeginIntentInput["feeType"];
	feeMultiplier: string;
	balancePrecision: BeginIntentInput["balancePrecision"];
	account: BeginIntentInput["account"];
	clientOrderId: string;
	submit: (request: CreateOrderV2Request) => Promise<A1Ack>;
}): Promise<{ submitted: boolean }> {
	const prepared = prepareA1Limit(args.order);
	if (typeof args.order.count !== "number") {
		throw new Error("Whole positive contract count required");
	}
	const result = await executeOnce(
		args.ledger,
		{
			clientOrderId: args.clientOrderId,
			ticker: args.order.ticker,
			side: args.order.side,
			action: args.order.action,
			count: args.order.count.toFixed(2),
			price: prepared.paidPrice,
			feeType: args.feeType,
			feeMultiplier: args.feeMultiplier,
			balancePrecision: args.balancePrecision,
			account: args.account,
		},
		() => args.submit(prepared.request),
	);
	return { submitted: result.submitted };
}
