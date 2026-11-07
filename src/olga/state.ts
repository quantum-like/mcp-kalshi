import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
	formatCount,
	formatMoney,
	parseCount,
	parseMoney,
} from "../lib/fixed.js";
import { STRATEGY_CAPITAL } from "../strategy/boundary.js";
import {
	type BalancePrecision,
	assertQuadraticFeeType,
	quoteBuyReservation,
	reservationFeeUnits,
} from "../strategy/fees.js";
import {
	applyFillToReservations,
	assertFillLedger,
	auditReservations,
	cashDeltaForFill,
	createReservation,
} from "./positions.js";

/** Maximum money that may be introduced from outside. Realized profit is separate. */
export const MAX_EXTERNAL_CAPITAL = STRATEGY_CAPITAL;
export const OLGA_MACHINE_ID = "f79c77c4-4b66-4a92-9669-f49bf82f9e59";
export const OLGA_HOME = "/Users/olgavlasova";
export const A1_KEYCHAIN_SERVICE = "mcp-kalshi-a1";
export const A1_KEYCHAIN_ACCOUNT = "olga-a1";
export const SEALED_POLICY_IDS: readonly string[] = [];
export const POLICY_GATES = [
	"fit",
	"prereg",
	"validate",
	"matchedHistory",
	"sourceDate",
	"readParity",
	"accountBound",
] as const;

const MANIFEST = "olga-manifest.json";
const OWNER = "olga-owner.json";
const RISK = "olga-risk.json";
const POLICY = "olga-policy.json";
const BINDING = "olga-binding.json";
const CLOCK = "olga-clock.json";
const STATE_FILES = [MANIFEST, OWNER, RISK, POLICY, BINDING, CLOCK] as const;

export type PolicyGate = (typeof POLICY_GATES)[number];
export type ReservationState = "held" | "submitting" | "unknown" | "released";

export interface Reservation {
	id: string;
	clientOrderId: string;
	side: "yes" | "no";
	action: "buy" | "sell";
	count: string;
	filled: string;
	cancelled: string;
	exitReleased: string;
	price: string;
	feeType: string;
	feeMultiplier: string;
	balancePrecision: BalancePrecision;
	coveredFee: string;
	originNotional: string;
	originEntryFee: string;
	originExitFee: string;
	reservedNotional: string;
	reservedEntryFee: string;
	reservedExitFee: string;
	amount: string;
	state: ReservationState;
}

export interface ReserveInput {
	clientOrderId: string;
	side: "yes" | "no";
	action: "buy" | "sell";
	count: string;
	price: string;
	feeType: string;
	feeMultiplier: string;
	balancePrecision: BalancePrecision;
}

export interface OwnerRecord {
	version: 2;
	machineId: typeof OLGA_MACHINE_ID;
	home: typeof OLGA_HOME;
	profile: "a1";
	fallback: "forbidden";
}

export interface RiskRecord {
	version: 3;
	profile: "a1";
	externalCapital: typeof MAX_EXTERNAL_CAPITAL;
	realizedPnl: string;
	allocated: string;
	reservations: Reservation[];
	appliedFills: Array<{
		fillId: string;
		clientOrderId: string;
		action: "buy" | "sell";
		count: string;
		price: string;
		fee: string;
		cashDelta: string;
	}>;
}

export interface PolicyRecord {
	version: 1;
	policyId: string;
	status: string;
	adaptation: "not-implemented";
	liveLearning: false;
	gates: Record<PolicyGate, boolean>;
}

export interface BindingRecord {
	version: 1;
	profile: "a1";
	keychainService: typeof A1_KEYCHAIN_SERVICE;
	keychainAccount: typeof A1_KEYCHAIN_ACCOUNT;
	bound: boolean;
	apiKeyId: string | null;
	memberId: string | null;
	subaccount: number | null;
	distinctFromMemberId: string | null;
}

export interface ClockRecord {
	version: 2;
	lastClockMs: number;
	lastExchangeMs: number | null;
	frozen: boolean;
	freezeReason: string | null;
}

export interface OlgaState {
	owner: OwnerRecord;
	risk: RiskRecord;
	policy: PolicyRecord;
	binding: BindingRecord;
	clock: ClockRecord;
}

export class OlgaRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OlgaRefusal";
	}
}

function closedGates(): Record<PolicyGate, false> {
	return {
		fit: false,
		prereg: false,
		validate: false,
		matchedHistory: false,
		sourceDate: false,
		readParity: false,
		accountBound: false,
	};
}

export function allocatedOf(reservations: Reservation[]): bigint {
	return reservations.reduce((sum, reservation) => {
		if (reservation.state === "released") return sum;
		const units = finiteMoney(reservation.amount);
		if (units < 0n) {
			throw new OlgaRefusal(
				"Amount must be a positive finite decimal. Negative and non-finite values are corrupt.",
			);
		}
		return sum + units;
	}, 0n);
}

export function spendableUnits(risk: RiskRecord): bigint {
	return (
		parseMoney(risk.externalCapital) +
		finiteMoney(risk.realizedPnl) -
		allocatedOf(risk.reservations)
	);
}

export function feeInclusiveHold(input: ReserveInput): string {
	assertQuadraticFeeType(input.feeType);
	if (input.action === "buy") {
		return quoteBuyReservation({
			count: input.count,
			price: input.price,
			multiplier: input.feeMultiplier,
			precision: input.balancePrecision,
			feeType: input.feeType,
		}).total;
	}
	return formatMoney(
		reservationFeeUnits(
			input.count,
			input.price,
			input.feeMultiplier,
			input.balancePrecision,
		),
	);
}

export async function initializeDisabledCandidate(
	directory: string,
	nowMs: number,
): Promise<OlgaState> {
	if (!Number.isFinite(nowMs)) {
		throw new OlgaRefusal("Refusing to initialize without a finite clock.");
	}
	const present = await existingStateFiles(directory);
	if (present.length > 0) {
		throw new OlgaRefusal(
			"Olga state already exists. Refusing to reset or replenish it.",
		);
	}
	const state: OlgaState = {
		owner: {
			version: 2,
			machineId: OLGA_MACHINE_ID,
			home: OLGA_HOME,
			profile: "a1",
			fallback: "forbidden",
		},
		risk: {
			version: 3,
			profile: "a1",
			externalCapital: MAX_EXTERNAL_CAPITAL,
			realizedPnl: formatMoney(0n),
			allocated: formatMoney(0n),
			reservations: [],
			appliedFills: [],
		},
		policy: {
			version: 1,
			policyId: "unvalidated",
			status: "unvalidated",
			adaptation: "not-implemented",
			liveLearning: false,
			gates: closedGates(),
		},
		binding: {
			version: 1,
			profile: "a1",
			keychainService: A1_KEYCHAIN_SERVICE,
			keychainAccount: A1_KEYCHAIN_ACCOUNT,
			bound: false,
			apiKeyId: null,
			memberId: null,
			subaccount: null,
			distinctFromMemberId: null,
		},
		clock: {
			version: 2,
			lastClockMs: nowMs,
			lastExchangeMs: null,
			frozen: false,
			freezeReason: null,
		},
	};
	await writeDurable(directory, MANIFEST, {
		version: 1,
		profile: "a1",
		files: STATE_FILES,
		enabled: false,
		orders: "disabled",
	});
	await writeDurable(directory, OWNER, state.owner);
	await writeDurable(directory, RISK, state.risk);
	await writeDurable(directory, POLICY, state.policy);
	await writeDurable(directory, BINDING, state.binding);
	await writeDurable(directory, CLOCK, state.clock);
	return state;
}

export async function loadOlgaState(
	directory: string,
): Promise<{ ok: true; state: OlgaState } | { ok: false; reason: string }> {
	const present = await existingStateFiles(directory);
	if (present.length === 0) {
		return {
			ok: false,
			reason:
				"Olga state is not initialized. Refusing to create a fresh ledger.",
		};
	}
	if (present.length !== STATE_FILES.length) {
		return {
			ok: false,
			reason: "Olga state is partial. Refusing to replenish a missing file.",
		};
	}
	try {
		const state: OlgaState = {
			owner: parseOwner(await readJson(directory, OWNER)),
			risk: parseRisk(await readJson(directory, RISK)),
			policy: parsePolicy(await readJson(directory, POLICY)),
			binding: parseBinding(await readJson(directory, BINDING)),
			clock: parseClock(await readJson(directory, CLOCK)),
		};
		return { ok: true, state };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "Olga state is corrupt.",
		};
	}
}

export async function saveRisk(
	directory: string,
	risk: RiskRecord,
): Promise<void> {
	await writeDurable(directory, RISK, parseRisk(risk));
}

export async function saveClock(
	directory: string,
	clock: ClockRecord,
): Promise<void> {
	await writeDurable(directory, CLOCK, parseClock(clock));
}

export async function saveBinding(
	directory: string,
	binding: BindingRecord,
): Promise<void> {
	await writeDurable(directory, BINDING, parseBinding(binding));
}

export function reserve(risk: RiskRecord, input: ReserveInput): RiskRecord {
	const parsed = parseRisk(risk);
	if (parsed.reservations.some((item) => item.state === "unknown")) {
		throw new OlgaRefusal(
			"An unknown order outcome is frozen. Refusing a new reservation or retry.",
		);
	}
	if (parsed.reservations.some((item) => item.state === "submitting")) {
		throw new OlgaRefusal(
			"An in-flight submitting order is frozen. Refusing a new reservation.",
		);
	}
	if (
		parsed.reservations.some(
			(item) => item.clientOrderId === input.clientOrderId,
		)
	) {
		throw new OlgaRefusal(
			"Client order id is already reserved. Refusing a duplicate in-flight id.",
		);
	}
	const reservation = createReservation(input, parsed.reservations);
	const units = finiteMoney(reservation.amount);
	if (units < 0n || units > spendableUnits(parsed)) {
		throw new OlgaRefusal(
			"Fee-inclusive reservation exceeds spendable bankroll. External capital stays 5.000000.",
		);
	}
	const reservations = [...parsed.reservations, reservation];
	return parseRisk({
		...parsed,
		allocated: formatMoney(allocatedOf(reservations)),
		reservations,
	});
}

export function bookRealized(_risk?: RiskRecord, _delta?: string): never {
	throw new OlgaRefusal(
		"Realized results come from a fill or settlement id. An arbitrary delta is not spendable.",
	);
}

export function applyOlgaFill(
	risk: RiskRecord,
	fill: {
		fillId: string;
		clientOrderId: string;
		action: "buy" | "sell";
		count: string;
		price: string;
		fee: string;
	},
): RiskRecord {
	const parsed = parseRisk(risk);
	if (parsed.appliedFills.some((item) => item.fillId === fill.fillId)) {
		return parsed;
	}
	const cashDelta = cashDeltaForFill(fill);
	const reservations = applyFillToReservations(parsed.reservations, {
		...fill,
		cashDelta,
	});
	const entry = { ...fill, cashDelta };
	const realized = formatMoney(
		finiteMoney(parsed.realizedPnl) + finiteMoney(cashDelta),
	);
	return parseRisk({
		...parsed,
		realizedPnl: realized,
		allocated: formatMoney(allocatedOf(reservations)),
		reservations,
		appliedFills: [...parsed.appliedFills, entry],
	});
}

export function rejectExternalTopUp(): never {
	throw new OlgaRefusal(
		"External capital cannot be topped up, leveraged, or taken from other funds.",
	);
}

export function rejectUnrealizedSpend(): never {
	throw new OlgaRefusal("Unrealized profit is not spendable.");
}

export function markUnknown(
	risk: RiskRecord,
	clientOrderId: string,
): RiskRecord {
	return mapReservation(risk, clientOrderId, (reservation) => {
		if (reservation.state === "released") {
			throw new OlgaRefusal("A released reservation cannot become unknown.");
		}
		return { ...reservation, state: "unknown" };
	});
}

export function markSubmitting(
	risk: RiskRecord,
	clientOrderId: string,
): RiskRecord {
	return mapReservation(risk, clientOrderId, (reservation) => {
		if (reservation.state !== "held") {
			throw new OlgaRefusal(
				"Only a held reservation can be marked submitting, and it is not retried.",
			);
		}
		return { ...reservation, state: "submitting" };
	});
}

export function releaseUnsent(
	risk: RiskRecord,
	clientOrderId: string,
	completeMiss: boolean,
): RiskRecord {
	if (!completeMiss) {
		throw new OlgaRefusal(
			"Incomplete read. The reservation stays frozen and is not retried.",
		);
	}
	return mapReservation(risk, clientOrderId, (reservation) => {
		if (reservation.state === "unknown") {
			throw new OlgaRefusal(
				"Unknown order outcome stays reserved. Refusing to release or retry it.",
			);
		}
		if (reservation.state !== "submitting") {
			throw new OlgaRefusal(
				"Only an unsent submitting reservation can be released.",
			);
		}
		return { ...reservation, state: "released" };
	});
}

function mapReservation(
	risk: RiskRecord,
	clientOrderId: string,
	change: (reservation: Reservation) => Reservation,
): RiskRecord {
	const parsed = parseRisk(risk);
	let found = false;
	const reservations = parsed.reservations.map((reservation) => {
		if (reservation.clientOrderId !== clientOrderId) return reservation;
		found = true;
		return change(reservation);
	});
	if (!found) {
		throw new OlgaRefusal("No reservation matches that client order id.");
	}
	return parseRisk({
		...parsed,
		allocated: formatMoney(allocatedOf(reservations)),
		reservations,
	});
}

function parseOwner(value: unknown): OwnerRecord {
	const record = object(value, "owner");
	if ("hostId" in record) {
		throw new OlgaRefusal(
			"A text host label is not a machine binding. No automatic fallback.",
		);
	}
	if (
		record.version !== 2 ||
		record.machineId !== OLGA_MACHINE_ID ||
		record.home !== OLGA_HOME ||
		record.profile !== "a1" ||
		record.fallback !== "forbidden"
	) {
		throw new OlgaRefusal(
			"Host ownership does not match the Olga machine. No automatic fallback.",
		);
	}
	return {
		version: 2,
		machineId: OLGA_MACHINE_ID,
		home: OLGA_HOME,
		profile: "a1",
		fallback: "forbidden",
	};
}

function parseRisk(value: unknown): RiskRecord {
	const record = object(value, "risk");
	if ("cap" in record || "unrealized" in record || "profit" in record) {
		throw new OlgaRefusal(
			"Risk state cannot store a permanent ceiling or unrealized profit.",
		);
	}
	rejectExtra(record, [
		"version",
		"profile",
		"externalCapital",
		"realizedPnl",
		"allocated",
		"reservations",
		"appliedFills",
	]);
	if (record.version !== 3 || record.profile !== "a1") {
		throw new OlgaRefusal("Risk record is not a1 version 3.");
	}
	if (record.externalCapital !== MAX_EXTERNAL_CAPITAL) {
		throw new OlgaRefusal(
			"External capital is not the initial 5.000000. Refusing a top-up or a reduced base.",
		);
	}
	if (typeof record.realizedPnl !== "string") {
		throw new OlgaRefusal("Realized result is not a finite decimal.");
	}
	finiteMoney(record.realizedPnl);
	if (!Array.isArray(record.reservations)) {
		throw new OlgaRefusal("Risk reservations are missing.");
	}
	const reservations = record.reservations.map(parseReservation);
	auditReservations(reservations);
	const allocated = formatMoney(allocatedOf(reservations));
	if (record.allocated !== allocated) {
		throw new OlgaRefusal(
			"Stored allocated risk does not match the reservations.",
		);
	}
	if (!Array.isArray(record.appliedFills)) {
		throw new OlgaRefusal("Applied fills are missing.");
	}
	const appliedFills = record.appliedFills.map(parseAppliedFill);
	const realized = formatMoney(finiteMoney(record.realizedPnl));
	assertFillLedger(reservations, appliedFills, realized);
	return {
		version: 3,
		profile: "a1",
		externalCapital: MAX_EXTERNAL_CAPITAL,
		realizedPnl: realized,
		allocated,
		reservations,
		appliedFills,
	};
}

function parseAppliedFill(value: unknown): RiskRecord["appliedFills"][number] {
	const record = object(value, "fill");
	const text = (key: string) => {
		const field = record[key];
		if (typeof field !== "string" || field.trim() === "") {
			throw new OlgaRefusal("Applied fill is unreadable.");
		}
		return field;
	};
	if (record.action !== "buy" && record.action !== "sell") {
		throw new OlgaRefusal("Applied fill action is unreadable.");
	}
	const action: "buy" | "sell" = record.action;
	const fill = {
		fillId: text("fillId"),
		clientOrderId: text("clientOrderId"),
		action,
		count: text("count"),
		price: text("price"),
		fee: text("fee"),
		cashDelta: text("cashDelta"),
	};
	if (fill.cashDelta !== cashDeltaForFill(fill)) {
		throw new OlgaRefusal(
			"Applied fill cash does not match its price, count, and fee.",
		);
	}
	return fill;
}

function parseReservation(value: unknown): Reservation {
	const record = object(value, "reservation");
	rejectExtra(record, [
		"id",
		"clientOrderId",
		"side",
		"action",
		"count",
		"filled",
		"cancelled",
		"exitReleased",
		"price",
		"feeType",
		"feeMultiplier",
		"balancePrecision",
		"coveredFee",
		"originNotional",
		"originEntryFee",
		"originExitFee",
		"reservedNotional",
		"reservedEntryFee",
		"reservedExitFee",
		"amount",
		"state",
	]);
	const text = (key: string) => {
		const field = record[key];
		if (typeof field !== "string") {
			throw new OlgaRefusal("Reservation identity or amount is unreadable.");
		}
		return field;
	};
	if (record.side !== "yes" && record.side !== "no") {
		throw new OlgaRefusal("Reservation side is unreadable.");
	}
	if (record.action !== "buy" && record.action !== "sell") {
		throw new OlgaRefusal("Reservation action is unreadable.");
	}
	if (
		record.balancePrecision !== "0.01" &&
		record.balancePrecision !== "0.0001"
	) {
		throw new OlgaRefusal("Reservation fee precision is unreadable.");
	}
	if (
		record.state !== "held" &&
		record.state !== "submitting" &&
		record.state !== "unknown" &&
		record.state !== "released"
	) {
		throw new OlgaRefusal("Reservation state is unknown.");
	}
	return {
		id: text("id"),
		clientOrderId: text("clientOrderId"),
		side: record.side,
		action: record.action,
		count: text("count"),
		filled: text("filled"),
		cancelled: text("cancelled"),
		exitReleased: text("exitReleased"),
		price: text("price"),
		feeType: text("feeType"),
		feeMultiplier: text("feeMultiplier"),
		balancePrecision: record.balancePrecision,
		coveredFee: text("coveredFee"),
		originNotional: text("originNotional"),
		originEntryFee: text("originEntryFee"),
		originExitFee: text("originExitFee"),
		reservedNotional: text("reservedNotional"),
		reservedEntryFee: text("reservedEntryFee"),
		reservedExitFee: text("reservedExitFee"),
		amount: text("amount"),
		state: record.state,
	};
}

function parsePolicy(value: unknown): PolicyRecord {
	const record = object(value, "policy");
	if ("cap" in record || "allocated" in record || "externalCapital" in record) {
		throw new OlgaRefusal("Policy state cannot carry or change the bankroll.");
	}
	if (
		record.liveLearning !== false ||
		record.adaptation !== "not-implemented"
	) {
		throw new OlgaRefusal(
			"Live learning or an adaptation change is forbidden.",
		);
	}
	if (record.version !== 1) {
		throw new OlgaRefusal("Policy record version is not 1.");
	}
	if (
		typeof record.policyId !== "string" ||
		typeof record.status !== "string"
	) {
		throw new OlgaRefusal("Policy id is unreadable.");
	}
	const gates = object(record.gates, "policy gates");
	const parsed = {} as Record<PolicyGate, boolean>;
	for (const gate of POLICY_GATES) {
		if (typeof gates[gate] !== "boolean") {
			throw new OlgaRefusal(`Policy gate ${gate} is unreadable.`);
		}
		parsed[gate] = gates[gate];
	}
	return {
		version: 1,
		policyId: record.policyId,
		status: record.status,
		adaptation: "not-implemented",
		liveLearning: false,
		gates: parsed,
	};
}

function parseBinding(value: unknown): BindingRecord {
	const record = object(value, "binding");
	if (
		record.version !== 1 ||
		record.profile !== "a1" ||
		record.keychainService !== A1_KEYCHAIN_SERVICE ||
		record.keychainAccount !== A1_KEYCHAIN_ACCOUNT
	) {
		throw new OlgaRefusal(
			"Account binding is not the separate a1 Keychain record.",
		);
	}
	const subaccount = record.subaccount;
	if (
		subaccount !== null &&
		(typeof subaccount !== "number" ||
			!Number.isInteger(subaccount) ||
			subaccount < 0 ||
			subaccount > 63)
	) {
		throw new OlgaRefusal(
			"Subaccount binding must be null or an integer 0-63.",
		);
	}
	if (typeof record.bound !== "boolean") {
		throw new OlgaRefusal("Account binding flag is unreadable.");
	}
	return {
		version: 1,
		profile: "a1",
		keychainService: A1_KEYCHAIN_SERVICE,
		keychainAccount: A1_KEYCHAIN_ACCOUNT,
		bound: record.bound,
		apiKeyId: nullableString(record.apiKeyId, "apiKeyId"),
		memberId: nullableString(record.memberId, "memberId"),
		subaccount,
		distinctFromMemberId: nullableString(
			record.distinctFromMemberId,
			"distinctFromMemberId",
		),
	};
}

function parseClock(value: unknown): ClockRecord {
	const record = object(value, "clock");
	if (
		record.version !== 2 ||
		typeof record.lastClockMs !== "number" ||
		!Number.isFinite(record.lastClockMs) ||
		typeof record.frozen !== "boolean"
	) {
		throw new OlgaRefusal("Clock record is unreadable.");
	}
	if (
		record.lastExchangeMs !== null &&
		(typeof record.lastExchangeMs !== "number" ||
			!Number.isFinite(record.lastExchangeMs))
	) {
		throw new OlgaRefusal("Exchange clock is not finite.");
	}
	if (record.freezeReason !== null && typeof record.freezeReason !== "string") {
		throw new OlgaRefusal("Clock freeze reason is unreadable.");
	}
	return {
		version: 2,
		lastClockMs: record.lastClockMs,
		lastExchangeMs: record.lastExchangeMs,
		frozen: record.frozen,
		freezeReason: record.freezeReason,
	};
}

function positiveMoney(input: string): bigint {
	const units = finiteMoney(input);
	if (units <= 0n) {
		throw new OlgaRefusal(
			"Amount must be a positive finite decimal. Negative and non-finite values are corrupt.",
		);
	}
	return units;
}

function finiteMoney(input: string): bigint {
	try {
		return parseMoney(input);
	} catch {
		throw new OlgaRefusal(
			"Amount is not a finite decimal. Negative and non-finite values are corrupt.",
		);
	}
}

function nullableString(value: unknown, label: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.trim() === "") {
		throw new OlgaRefusal(`${label} must be a string or null.`);
	}
	return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new OlgaRefusal(`${label} record is corrupt.`);
	}
	return value as Record<string, unknown>;
}

function rejectExtra(record: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new OlgaRefusal(
				`Unexpected field ${key}. Refusing to interpret it as profit or a cap change.`,
			);
		}
	}
}

async function existingStateFiles(directory: string): Promise<string[]> {
	let names: string[] = [];
	try {
		names = await readdir(directory);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw error;
	}
	return STATE_FILES.filter((name) => names.includes(name));
}

async function readJson(directory: string, name: string): Promise<unknown> {
	const raw = await readFile(join(directory, name), "utf8");
	return JSON.parse(raw) as unknown;
}

async function writeDurable(
	directory: string,
	name: string,
	value: unknown,
): Promise<void> {
	const target = join(directory, name);
	const temporary = `${target}.${process.pid}.tmp`;
	const handle = await open(temporary, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, target);
	const directoryHandle = await open(directory, "r");
	try {
		await directoryHandle.sync();
	} finally {
		await directoryHandle.close();
	}
}
