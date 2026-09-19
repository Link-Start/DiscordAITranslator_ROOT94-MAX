const test = require("node:test");
const assert = require("node:assert/strict");
const {
	LIVE_SLOT_CAPACITY,
	createLiveSlotLeaseOwner
} = require("../src/orchestrator/live-slot-lease-owner");

test("the owner grants one opaque lease and refuses capacity overflow", () => {
	const owner = createLiveSlotLeaseOwner();
	const lease = owner.tryAcquire();

	assert.equal(LIVE_SLOT_CAPACITY, 1);
	assert.equal(owner.getCapacity(), 1);
	assert.equal(owner.getActiveCount(), 1);
	assert.ok(lease);
	assert.equal(Object.isFrozen(lease), true);
	assert.deepEqual(Object.keys(lease), []);
	assert.equal(owner.tryAcquire(), null, "cap=1 never grants a parallel lease");

	assert.equal(owner.release(lease), true);
	assert.equal(owner.getActiveCount(), 0);
	assert.ok(owner.tryAcquire(), "the released slot can be acquired again");
});

test("release is exact-token and idempotent", () => {
	const owner = createLiveSlotLeaseOwner();
	const lease = owner.tryAcquire();

	assert.equal(owner.owns(lease), true, "the exact live identity is recognized");
	assert.equal(owner.owns(Object.freeze({})), false, "an opaque lookalike is not owned");
	assert.equal(owner.release(null), false);
	assert.equal(owner.release(Object.freeze({})), false, "a forged frozen object has no authority");
	assert.equal(owner.getActiveCount(), 1);
	assert.equal(owner.release(lease), true);
	assert.equal(owner.owns(lease), false, "released identities are immediately stale");
	assert.equal(owner.release(lease), false, "a duplicate release is a no-op");
	assert.equal(owner.getActiveCount(), 0);
});

test("reset invalidates old-generation leases without freeing a new one", () => {
	const owner = createLiveSlotLeaseOwner();
	const staleLease = owner.tryAcquire();
	owner.reset();
	const currentLease = owner.tryAcquire();

	assert.equal(owner.owns(staleLease), false);
	assert.equal(owner.owns(currentLease), true);
	assert.equal(owner.release(staleLease), false, "a stale completion cannot release the current generation");
	assert.equal(owner.getActiveCount(), 1);
	assert.equal(owner.release(currentLease), true);
	assert.equal(owner.getActiveCount(), 0);
});

test("active-count notifications fire only for real transitions and are guarded", () => {
	const counts = [];
	const owner = createLiveSlotLeaseOwner({
		onActiveCountChanged: count => {
			counts.push(count);
			if (count === 1) throw new Error("observer failure");
		}
	});

	let first = null;
	assert.doesNotThrow(() => {first = owner.tryAcquire();});
	assert.equal(owner.tryAcquire(), null);
	assert.equal(owner.release(Object.freeze({})), false);
	assert.equal(owner.release(first), true);
	assert.equal(owner.release(first), false);
	owner.reset();
	const second = owner.tryAcquire();
	owner.reset();
	assert.equal(owner.release(second), false);

	assert.deepEqual(counts, [1, 0, 1, 0], "refused, duplicate, forged and empty reset paths stay silent");
});

test("the UI capacity setter supports one or two without revoking active leases", () => {
	const owner = createLiveSlotLeaseOwner();
	const first = owner.tryAcquire();
	assert.equal(owner.setCapacity(2), 2);
	const second = owner.tryAcquire();
	assert.ok(second);
	assert.equal(owner.getActiveCount(), 2);
	assert.equal(owner.tryAcquire(), null);
	assert.equal(owner.setCapacity(1), 1);
	assert.equal(owner.tryAcquire(), null, "downscale drains existing work before another grant");
	assert.equal(owner.release(first), true);
	assert.equal(owner.tryAcquire(), null, "one remaining lease still fills cap1");
	assert.equal(owner.release(second), true);
	assert.ok(owner.tryAcquire());
	assert.equal(owner.setCapacity(99), 2, "values are clamped to the UI contract");
});
