import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { formatMoney, parseMoney } from "../lib/fixed.js";
import { STRATEGY_CAPITAL } from "../strategy/boundary.js";

export const RISK_CAP = STRATEGY_CAPITAL;
export const OLGA_HOST_ID = "olga";
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
	amount: string;
	state: ReservationState;
}

export interface OwnerRecord {
	version: 1;
	hostId: typeof OLGA_HOST_ID;
	profile: "a1";
	fallback: "forbidden";
}

export interface RiskRecord {
	version: 1;
	profile: "a1";
	cap: typeof RISK_CAP;
	allocated: string;
	reservations: Reservation[];
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
	version: 1;
	lastClockMs: number;
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
		return sum + parseMoney(reservation.amount);
	}, 0n);
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
			version: 1,
			hostId: OLGA_HOST_ID,
			profile: "a1",
			fallback: "forbidden",
		},
		risk: {
			version: 1,
			profile: "a1",
			cap: RISK_CAP,
			allocated: formatMoney(0n),
			reservations: [],
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
			version: 1,
			lastClockMs: nowMs,
			frozen: false,
			freezeReason: null,
		},
	};
	await writeDurable(directory, MANIFEST, {
		version: 1,
		profile: "a1",
		files: STATE_FILES,
		enabled: false,
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
	const parsed = parseRisk(risk);
	await writeDurable(directory, RISK, parsed);
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

export function reserve(
	risk: RiskRecord,
	amount: string,
	clientOrderId: string,
): RiskRecord {
	const parsed = parseRisk(risk);
	if (parsed.reservations.some((item) => item.state === "unknown")) {
		throw new OlgaRefusal(
			"An unknown order outcome is frozen. Refusing a new reservation or retry.",
		);
	}
	if (parsed.reservations.some((item) => item.state === "submitting")) {
		throw new OlgaRefusal(
			"An orphan submitting order is frozen. Refusing a new reservation.",
		);
	}
	const units = parseMoney(amount);
	if (units <= 0n) throw new OlgaRefusal("Reservation must be positive.");
	const next = allocatedOf(parsed.reservations) + units;
	if (next > parseMoney(RISK_CAP)) {
		throw new OlgaRefusal(
			"Reservation would exceed the immutable $5 total risk cap.",
		);
	}
	const reservations = [
		...parsed.reservations,
		{
			id: randomUUID(),
			clientOrderId,
			amount: formatMoney(units),
			state: "held" as const,
		},
	];
	return parseRisk({
		...parsed,
		allocated: formatMoney(allocatedOf(reservations)),
		reservations,
	});
}

export function markUnknown(
	risk: RiskRecord,
	clientOrderId: string,
): RiskRecord {
	const parsed = parseRisk(risk);
	let found = false;
	const reservations = parsed.reservations.map((reservation) => {
		if (reservation.clientOrderId !== clientOrderId) return reservation;
		if (reservation.state === "released") {
			throw new OlgaRefusal("A released reservation cannot become unknown.");
		}
		found = true;
		return { ...reservation, state: "unknown" as const };
	});
	if (!found)
		throw new OlgaRefusal("No reservation matches that client order id.");
	return parseRisk({
		...parsed,
		allocated: formatMoney(allocatedOf(reservations)),
		reservations,
	});
}

export function markSubmitting(
	risk: RiskRecord,
	clientOrderId: string,
): RiskRecord {
	const parsed = parseRisk(risk);
	let found = false;
	const reservations = parsed.reservations.map((reservation) => {
		if (reservation.clientOrderId !== clientOrderId) return reservation;
		if (reservation.state !== "held") {
			throw new OlgaRefusal(
				"Only a held reservation can be marked submitting, and it is not retried.",
			);
		}
		found = true;
		return { ...reservation, state: "submitting" as const };
	});
	if (!found)
		throw new OlgaRefusal("No held reservation matches that client order id.");
	return parseRisk({
		...parsed,
		reservations,
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
	const parsed = parseRisk(risk);
	let found = false;
	const reservations = parsed.reservations.map((reservation) => {
		if (reservation.clientOrderId !== clientOrderId) return reservation;
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
		found = true;
		return { ...reservation, state: "released" as const };
	});
	if (!found)
		throw new OlgaRefusal("No submitting reservation matches that id.");
	return parseRisk({
		...parsed,
		allocated: formatMoney(allocatedOf(reservations)),
		reservations,
	});
}

export function rejectProfitOrTopUp(): never {
	throw new OlgaRefusal(
		"Profits, top-ups, adaptation, and restarts cannot raise or reset the $5 cap.",
	);
}

function parseOwner(value: unknown): OwnerRecord {
	const record = object(value, "owner");
	if (
		record.version !== 1 ||
		record.hostId !== OLGA_HOST_ID ||
		record.profile !== "a1" ||
		record.fallback !== "forbidden"
	) {
		throw new OlgaRefusal(
			"Host ownership does not match Olga a1. No automatic fallback.",
		);
	}
	return {
		version: 1,
		hostId: OLGA_HOST_ID,
		profile: "a1",
		fallback: "forbidden",
	};
}

function parseRisk(value: unknown): RiskRecord {
	const record = object(value, "risk");
	rejectExtra(record, [
		"version",
		"profile",
		"cap",
		"allocated",
		"reservations",
	]);
	if (record.version !== 1 || record.profile !== "a1") {
		throw new OlgaRefusal("Risk record is not a1 version 1.");
	}
	if (record.cap !== RISK_CAP) {
		throw new OlgaRefusal(
			"Risk cap is not the immutable 5.000000 total. Refusing to load it.",
		);
	}
	if (!Array.isArray(record.reservations)) {
		throw new OlgaRefusal("Risk reservations are missing.");
	}
	const reservations = record.reservations.map(parseReservation);
	const allocated = formatMoney(allocatedOf(reservations));
	if (record.allocated !== allocated) {
		throw new OlgaRefusal(
			"Stored allocated risk does not match the reservations.",
		);
	}
	if (parseMoney(allocated) > parseMoney(RISK_CAP)) {
		throw new OlgaRefusal("Allocated risk is above the $5 cap.");
	}
	return {
		version: 1,
		profile: "a1",
		cap: RISK_CAP,
		allocated,
		reservations,
	};
}

function parseReservation(value: unknown): Reservation {
	const record = object(value, "reservation");
	rejectExtra(record, ["id", "clientOrderId", "amount", "state"]);
	if (
		typeof record.id !== "string" ||
		typeof record.clientOrderId !== "string" ||
		typeof record.amount !== "string"
	) {
		throw new OlgaRefusal("Reservation identity or amount is unreadable.");
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
		id: record.id,
		clientOrderId: record.clientOrderId,
		amount: formatMoney(parseMoney(record.amount)),
		state: record.state,
	};
}

function parsePolicy(value: unknown): PolicyRecord {
	const record = object(value, "policy");
	if ("cap" in record || "allocated" in record) {
		throw new OlgaRefusal("Policy state cannot carry or change the risk cap.");
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
		record.version !== 1 ||
		typeof record.lastClockMs !== "number" ||
		!Number.isFinite(record.lastClockMs) ||
		typeof record.frozen !== "boolean"
	) {
		throw new OlgaRefusal("Clock record is unreadable.");
	}
	if (record.freezeReason !== null && typeof record.freezeReason !== "string") {
		throw new OlgaRefusal("Clock freeze reason is unreadable.");
	}
	return {
		version: 1,
		lastClockMs: record.lastClockMs,
		frozen: record.frozen,
		freezeReason: record.freezeReason,
	};
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
