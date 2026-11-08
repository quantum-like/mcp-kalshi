export const MIN_GAP_MS = 10_000;

export function createLimiter(clock, minGapMs = MIN_GAP_MS) {
	let nextStart = 0;
	return {
		async acquire() {
			const wait = Math.max(0, nextStart - clock.now());
			if (wait > 0) await clock.sleep(wait);
			const started = clock.now();
			nextStart = started + minGapMs;
			return started;
		},
	};
}

export function createFakeClock(start = 0) {
	let now = start;
	const sleeps = [];
	return {
		now: () => now,
		sleep: async (ms) => {
			if (!Number.isFinite(ms) || ms < 0) throw new Error("bad sleep");
			sleeps.push(ms);
			now += ms;
		},
		sleeps,
		advance(ms) {
			now += ms;
		},
	};
}
