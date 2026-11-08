import type { StrategyLedger } from "./ledger.js";

export interface ReconOrder {
	order_id: string;
	client_order_id?: string;
	status?: string;
	fill_count_fp?: string;
	remaining_count_fp?: string;
}

export interface ReconFill {
	fill_id: string;
	order_id?: string;
	client_order_id?: string;
	ticker: string;
	count_fp: string;
	price: string;
	fee: string;
	action: "buy" | "sell";
	outcomeSide: "yes" | "no";
}

export interface ReconSnapshot {
	ordersComplete: boolean;
	fillsComplete: boolean;
	orders: ReconOrder[];
	fills: ReconFill[];
}

/**
 * The only recovery path for an a1 intent. Scans sanctioned order and fill
 * reads for an exact client_order_id. It never submits.
 */
export async function reconcileFromReads(
	ledger: StrategyLedger,
	snapshot: ReconSnapshot,
): Promise<{ resubmits: 0; notes: string[] }> {
	const notes: string[] = [];
	const state = await ledger.status();
	for (const intent of state.intents) {
		if (
			intent.state !== "submitting" &&
			intent.state !== "unknown" &&
			intent.state !== "acknowledged"
		) {
			continue;
		}
		if (!snapshot.ordersComplete || !snapshot.fillsComplete) {
			notes.push(`${intent.id} stays ${intent.state}; read incomplete`);
			continue;
		}
		const matched = snapshot.orders.filter(
			(order) => order.client_order_id === intent.clientOrderId,
		);
		const fills = snapshot.fills.filter(
			(fill) =>
				fill.client_order_id === intent.clientOrderId ||
				matched.some((order) => order.order_id === fill.order_id),
		);
		if (matched.length === 0 && fills.length === 0) {
			await ledger.releaseIfAbsent(intent.id, true);
			notes.push(`${intent.id} released; complete read found no order`);
			continue;
		}
		const order = matched[0];
		if (order) {
			await ledger.recordAck(intent.id, {
				orderId: order.order_id,
				fillCount: order.fill_count_fp,
				remainingCount: order.remaining_count_fp,
			});
		}
		for (const fill of fills) {
			await ledger.applyFill({
				fillId: fill.fill_id,
				orderId: fill.order_id,
				clientOrderId: intent.clientOrderId,
				ticker: fill.ticker,
				outcomeSide: fill.outcomeSide,
				count: fill.count_fp,
				price: fill.price,
				fee: fill.fee,
				action: fill.action,
			});
		}
		notes.push(`${intent.id} reconciled from reads`);
	}
	return { resubmits: 0, notes };
}
