// Test observation diffing

function deepDiff(prev, curr) {
	if (prev === curr) return undefined;
	if (prev == null || curr == null || typeof prev !== typeof curr) return curr;
	if (typeof curr !== "object") return prev === curr ? undefined : curr;
	if (Array.isArray(curr)) {
		return JSON.stringify(prev) === JSON.stringify(curr) ? undefined : curr;
	}
	const result = {};
	for (const key of new Set([...Object.keys(prev), ...Object.keys(curr)])) {
		if (!(key in curr)) { result[key] = null; continue; }
		if (!(key in prev)) { result[key] = curr[key]; continue; }
		const d = deepDiff(prev[key], curr[key]);
		if (d !== undefined) result[key] = d;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function diffEntityArrays(prev, curr) {
	const prevMap = new Map();
	for (const e of prev) prevMap.set(e.id, JSON.stringify(e));
	const currMap = new Map();
	for (const e of curr) currMap.set(e.id, JSON.stringify(e));

	const changed = [];
	const added = [];
	const removed = [];

	for (const e of curr) {
		const prevStr = prevMap.get(e.id);
		if (prevStr == null) { added.push(e); continue; }
		if (prevStr !== JSON.stringify(e)) changed.push(e);
	}
	for (const id of prevMap.keys()) {
		if (!currMap.has(id)) removed.push(id);
	}

	if (changed.length === 0 && added.length === 0 && removed.length === 0) return undefined;
	const result = {};
	if (changed.length > 0) result.changed = changed;
	if (added.length > 0) result.added = added;
	if (removed.length > 0) result.removed = removed;
	return result;
}

function diffObservation(prev, curr) {
	if (!prev) return curr;
	const diff = { tick: curr.tick, game_status: curr.game_status, events: curr.events || [] };
	const playerDiff = deepDiff(prev.player, curr.player);
	if (playerDiff) diff.player = playerDiff;
	const otherDiff = deepDiff(prev.other_players, curr.other_players);
	if (otherDiff) diff.other_players = otherDiff;
	if (prev.world?.entities && curr.world?.entities) {
		const entDiff = diffEntityArrays(prev.world.entities, curr.world.entities);
		if (entDiff) diff.world = { entities: entDiff };
	} else {
		const worldDiff = deepDiff(prev.world, curr.world);
		if (worldDiff) diff.world = worldDiff;
	}
	return diff;
}

// --- Test data ---
const staticEntities = [
	{ id: 5, name: "Ground", position: [0, -0.5, 0], size: [100, 1, 100], color: [0.33, 0.94, 0.77] },
	{ id: 6, name: "LowStep", position: [8, 1, 18], size: [8, 2, 10], color: [0.78, 0.63, 0.39] },
	{ id: 7, name: "LargeMesa", position: [20, 2, 20], size: [20, 4, 16], color: [0.78, 0.63, 0.39] },
];

const playerEntity = (pos) => ({ id: 19, name: "HumanoidRootPart", position: pos, size: [2, 5, 2], color: [0.9, 0.45, 0.3] });

function makeObs(tick, playerPos) {
	return {
		tick,
		game_status: "active",
		player: { id: "abc", position: playerPos, health: 100, attributes: { ViewForwardX: 0, ViewForwardZ: -1 } },
		other_players: [],
		world: { entities: [...staticEntities, playerEntity(playerPos)] },
		events: [],
	};
}

// --- Tests ---
let pass = 0;
let fail = 0;

function assert(cond, msg) {
	if (cond) { pass++; }
	else { fail++; console.error(`FAIL: ${msg}`); }
}

// Test 1: first observation (prev=null) returns full
const obs1 = makeObs(100, [0, 2.55, 0]);
const diff1 = diffObservation(null, obs1);
assert(diff1 === obs1, "first observation should return full object");

// Test 2: identical observation — no player/world changes
const obs2 = makeObs(200, [0, 2.55, 0]);
const diff2 = diffObservation(obs1, obs2);
assert(diff2.tick === 200, "tick should be 200");
assert(diff2.player === undefined, "player unchanged → omitted");
assert(diff2.world === undefined, "world unchanged → omitted");
assert(JSON.stringify(diff2.events) === "[]", "events always included");
console.log("Idle diff:", JSON.stringify(diff2));

// Test 3: player moved — player fields and entity change
const obs3 = makeObs(300, [5, 2.55, 3]);
const diff3 = diffObservation(obs2, obs3);
assert(diff3.tick === 300, "tick should be 300");
assert(diff3.player !== undefined, "player should be in diff");
assert(JSON.stringify(diff3.player.position) === "[5,2.55,3]", "player position should be new");
assert(diff3.player.health === undefined, "health unchanged → omitted");
assert(diff3.world !== undefined, "world should have entity diff");
assert(diff3.world.entities.changed.length === 1, "only HumanoidRootPart changed");
assert(diff3.world.entities.changed[0].id === 19, "changed entity is id 19");
assert(diff3.world.entities.added === undefined, "no entities added");
assert(diff3.world.entities.removed === undefined, "no entities removed");
console.log("Move diff:", JSON.stringify(diff3));

// Test 4: entity added
const obs4 = makeObs(400, [5, 2.55, 3]);
obs4.world.entities.push({ id: 20, name: "NewBlock", position: [10, 0, 10], size: [4, 4, 4] });
const diff4 = diffObservation(obs3, obs4);
assert(diff4.world.entities.added.length === 1, "one entity added");
assert(diff4.world.entities.added[0].id === 20, "added entity is id 20");
console.log("Add entity diff:", JSON.stringify(diff4));

// Test 5: entity removed
const obs5 = makeObs(500, [5, 2.55, 3]);
// obs5 doesn't have entity 20 (which obs4 had)
const diff5 = diffObservation(obs4, obs5);
assert(diff5.world.entities.removed.length === 1, "one entity removed");
assert(diff5.world.entities.removed[0] === 20, "removed entity is id 20");
console.log("Remove entity diff:", JSON.stringify(diff5));

// Test 6: size comparison — diff should be much smaller than full
const fullSize = JSON.stringify(obs3).length;
const diffSize = JSON.stringify(diff3).length;
console.log(`\nFull observation: ${fullSize} chars`);
console.log(`Diff (player moved): ${diffSize} chars`);
console.log(`Savings: ${((1 - diffSize / fullSize) * 100).toFixed(0)}%`);

const idleSize = JSON.stringify(diff2).length;
console.log(`Diff (idle): ${idleSize} chars`);
console.log(`Savings (idle): ${((1 - idleSize / fullSize) * 100).toFixed(0)}%`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
