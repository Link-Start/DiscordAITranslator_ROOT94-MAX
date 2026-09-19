const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HISTORICAL_PHYSICAL_CAPACITY_MIN,
	HISTORICAL_PHYSICAL_CAPACITY_MAX,
	createHistoricalPhysicalLeaseOwner
} = require("../src/orchestrator/historical-physical-lease-owner");

async function isPending(promise) {
	const pending = Symbol("pending");
	return await Promise.race([promise, Promise.resolve(pending)]) === pending;
}

test("capacity one through four is configurable and shared across every historical job", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 2});
	const first = await owner.acquire({isCurrent: () => true});
	const second = await owner.acquire({isCurrent: () => true});
	const thirdPromise = owner.acquire({isCurrent: () => true});

	assert.equal(HISTORICAL_PHYSICAL_CAPACITY_MIN, 1);
	assert.equal(HISTORICAL_PHYSICAL_CAPACITY_MAX, 4);
	assert.ok(first);
	assert.ok(second);
	assert.notEqual(first, second);
	assert.equal(await isPending(thirdPromise), true, "a third job cannot exceed the global cap");
	assert.deepEqual(owner.getSnapshot(), {
		capacity: 2,
		active: 2,
		waiting: 1,
		highWater: 2,
		generation: 0,
		stopped: false
	});

	assert.equal(owner.release(first), true);
	const third = await thirdPromise;
	assert.ok(third, "releasing either job's token wakes the globally queued job");
	assert.equal(owner.getSnapshot().active, 2);
	assert.equal(owner.release(second), true);
	assert.equal(owner.release(third), true);
});

test("waiters are granted in FIFO order", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	const order = [];
	const first = await owner.acquire({isCurrent: () => true});
	const secondPromise = owner.acquire({isCurrent: () => {
		order.push("second");
		return true;
	}});
	const thirdPromise = owner.acquire({isCurrent: () => {
		order.push("third");
		return true;
	}});

	assert.equal(await isPending(secondPromise), true);
	assert.equal(await isPending(thirdPromise), true);
	owner.release(first);
	const second = await secondPromise;
	assert.deepEqual(order, ["second"]);
	assert.equal(await isPending(thirdPromise), true, "the later waiter stays behind the earlier lease");
	owner.release(second);
	const third = await thirdPromise;
	assert.deepEqual(order, ["second", "third"]);
	owner.release(third);
});

test("a waiter that became stale returns null at grant time and occupies no slot", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	let secondIsCurrent = true;
	const first = await owner.acquire({isCurrent: () => true});
	const stalePromise = owner.acquire({isCurrent: () => secondIsCurrent});
	const currentPromise = owner.acquire({isCurrent: () => true});

	secondIsCurrent = false;
	owner.release(first);

	assert.equal(await stalePromise, null);
	const current = await currentPromise;
	assert.ok(current, "the stale waiter is skipped and the next FIFO waiter receives the slot");
	assert.deepEqual(owner.getSnapshot(), {
		capacity: 1,
		active: 1,
		waiting: 0,
		highWater: 1,
		generation: 0,
		stopped: false
	});
	owner.release(current);
});

test("a throwing or re-entrantly stopped currentness check cannot acquire", async () => {
	const throwingOwner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	assert.equal(await throwingOwner.acquire({isCurrent: () => {
		throw new Error("stale reader");
	}}), null);
	assert.equal(throwingOwner.getSnapshot().active, 0);

	const stoppedOwner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	assert.equal(await stoppedOwner.acquire({isCurrent: () => {
		stoppedOwner.stop();
		return true;
	}}), null);
	assert.equal(stoppedOwner.getSnapshot().active, 0);
	assert.equal(stoppedOwner.getSnapshot().stopped, true);
});

test("release is exact-token, idempotent, and wakes only once", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	const first = await owner.acquire({isCurrent: () => true});
	const nextPromise = owner.acquire({isCurrent: () => true});

	assert.equal(Object.isFrozen(first), true);
	assert.deepEqual(Object.keys(first), []);
	assert.equal(owner.owns(first), true);
	assert.equal(owner.owns(Object.freeze({})), false);
	assert.equal(owner.release(Object.freeze({})), false);
	assert.equal(owner.release(first), true);
	assert.equal(owner.release(first), false);

	const next = await nextPromise;
	assert.equal(owner.owns(first), false);
	assert.equal(owner.owns(next), true);
	assert.equal(owner.getSnapshot().active, 1);
	assert.equal(owner.release(next), true);
	assert.equal(owner.release(next), false);
});

test("reset stops dispatch, rejects queued work, and drains without forgetting in-flight leases", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 2});
	const first = await owner.acquire({isCurrent: () => true});
	const second = await owner.acquire({isCurrent: () => true});
	const queuedPromise = owner.acquire({isCurrent: () => true});

	const drainPromise = owner.reset();
	assert.equal(await queuedPromise, null, "queued work is cancelled before another physical dispatch");
	assert.equal(await owner.acquire({isCurrent: () => true}), null, "new work stays stopped");
	assert.equal(owner.owns(first), true, "reset retains physical ownership until completion releases it");
	assert.equal(owner.owns(second), true);
	assert.deepEqual(owner.getSnapshot(), {
		capacity: 2,
		active: 2,
		waiting: 0,
		highWater: 2,
		generation: 1,
		stopped: true
	});
	assert.equal(await isPending(drainPromise), true);

	assert.equal(owner.release(first), true);
	assert.equal(await isPending(drainPromise), true, "drain waits for every physical lease");
	assert.equal(owner.release(second), true);
	await drainPromise;
	assert.equal(owner.getSnapshot().active, 0);
	assert.equal(owner.release(second), false);
	assert.equal(owner.stop(), false, "a repeated stop is idempotent");
	assert.equal(owner.getSnapshot().generation, 1);
});

test("capacity changes wake FIFO waiters without revoking active leases", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	const first = await owner.acquire({isCurrent: () => true});
	const secondPromise = owner.acquire({isCurrent: () => true});

	assert.equal(owner.setCapacity(2), true);
	const second = await secondPromise;
	assert.equal(owner.getSnapshot().active, 2);
	assert.equal(owner.setCapacity(2), false);
	assert.equal(owner.setCapacity(1), true, "pressure may lower the refill cap while two old leases drain");
	const thirdPromise = owner.acquire({isCurrent: () => true});
	assert.equal(await isPending(thirdPromise), true);
	assert.throws(() => owner.setCapacity(0), /capacity/);
	assert.throws(() => owner.setCapacity(5), /capacity/);
	assert.throws(() => createHistoricalPhysicalLeaseOwner({capacity: 1.5}), /capacity/);

	owner.release(first);
	assert.equal(await isPending(thirdPromise), true, "one remaining active lease still fills the reduced cap");
	owner.release(second);
	const third = await thirdPromise;
	assert.equal(owner.getSnapshot().capacity, 1);
	owner.release(third);
});

test("capacity four grants exactly four global leases and queues the fifth", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 4});
	const leases = [];
	for (let index = 0; index < 4; index++) leases.push(await owner.acquire({isCurrent: () => true}));
	const fifthPromise = owner.acquire({isCurrent: () => true});
	assert.equal(owner.getSnapshot().active, 4);
	assert.equal(owner.getSnapshot().highWater, 4);
	assert.equal(await isPending(fifthPromise), true);
	owner.release(leases.shift());
	const fifth = await fifthPromise;
	assert.ok(fifth);
	for (const lease of leases) owner.release(lease);
	owner.release(fifth);
	assert.equal(owner.getSnapshot().active, 0);
});

test("start reopens a stopped owner without forgetting old in-flight leases", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 2});
	const first = await owner.acquire({isCurrent: () => true});
	const second = await owner.acquire({isCurrent: () => true});
	owner.stop();
	assert.equal(owner.start(1), true);
	const nextPromise = owner.acquire({isCurrent: () => true});
	assert.equal(await isPending(nextPromise), true);
	owner.release(first);
	assert.equal(await isPending(nextPromise), true);
	owner.release(second);
	const next = await nextPromise;
	assert.ok(next);
	assert.equal(owner.getSnapshot().highWater, 2);
	owner.release(next);
});

test("stop-drain-start fences the old generation and its drain ignores fresh work", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 2});
	const oldLease = await owner.acquire({isCurrent: () => true});
	const draining = owner.reset();

	assert.equal(owner.start(2), true);
	const freshPromise = owner.acquire({isCurrent: () => true});
	assert.equal(await isPending(freshPromise), true, "a restarted waiter cannot mix with the stopped generation");

	owner.release(oldLease);
	const freshLease = await freshPromise;
	assert.ok(freshLease, "new-generation work starts only after the old physical lease settles");
	await draining;
	assert.equal(owner.owns(freshLease), true, "the old generation drain is not extended by fresh work");
	owner.release(freshLease);
});

test("a granted speculative lease becomes non-dispatchable after capacity drops", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 2});
	const first = await owner.acquire({isCurrent: () => true});
	const second = await owner.acquire({isCurrent: () => true});
	assert.equal(owner.isDispatchable(first), true);
	assert.equal(owner.isDispatchable(second), true);

	owner.setCapacity(1);
	assert.equal(owner.isDispatchable(first), true, "the oldest physical turn keeps the surviving slot");
	assert.equal(owner.isDispatchable(second), false, "a granted but not-yet-dispatched second turn must yield");
	owner.release(first);
	assert.equal(owner.isDispatchable(second), true);
	owner.release(second);
});

test("capacity four downscales to one by acquisition order without revoking old leases", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 4});
	const leases = [];
	for (let index = 0; index < 4; index++) leases.push(await owner.acquire({isCurrent: () => true}));
	owner.setCapacity(1);
	assert.deepEqual(leases.map(lease => owner.isDispatchable(lease)), [true, false, false, false]);
	owner.release(leases[0]);
	assert.deepEqual(leases.slice(1).map(lease => owner.isDispatchable(lease)), [true, false, false]);
	for (const lease of leases.slice(1)) owner.release(lease);
	assert.equal(owner.getSnapshot().active, 0);
});

test("snapshot is frozen, bounded metadata with no lease or caller data", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 1});
	const lease = await owner.acquire({isCurrent: () => true});
	const snapshot = owner.getSnapshot();

	assert.equal(Object.isFrozen(snapshot), true);
	assert.deepEqual(Object.keys(snapshot).sort(), [
		"active",
		"capacity",
		"generation",
		"highWater",
		"stopped",
		"waiting"
	]);
	assert.equal(JSON.stringify(snapshot).includes("token"), false);
	assert.equal(JSON.stringify(snapshot).includes("message"), false);
	assert.equal(JSON.stringify(snapshot).includes("channel"), false);
	assert.equal(JSON.stringify(snapshot).includes("provider"), false);
	owner.release(lease);
});

test("one hundred cap4 stop-drain-start cycles leave no physical lease or waiter", async () => {
	const owner = createHistoricalPhysicalLeaseOwner({capacity: 4});
	for (let cycle = 0; cycle < 100; cycle++) {
		const leases = [];
		for (let index = 0; index < 4; index++) leases.push(await owner.acquire({isCurrent: () => true}));
		const queued = owner.acquire({isCurrent: () => true});
		const draining = owner.reset();
		assert.equal(await queued, null);
		for (const lease of leases) owner.release(lease);
		await draining;
		assert.equal(owner.getSnapshot().active, 0);
		assert.equal(owner.getSnapshot().waiting, 0);
		if (cycle < 99) owner.start(4);
	}
});
