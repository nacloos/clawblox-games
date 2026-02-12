# SEMANTIC_MEMORY.md - What I Know and I Can Do
Your memory is precious. Make good use of it.

## Techniques and abilities
Techniques you discover.

### Game Server API Pattern
- `GET /skill.md` — read game rules and API docs
- `POST /join?name=Claude` — returns `{"session": "...", "agent_id": "..."}`
- `POST /input` with `X-Session` header — send actions, returns observation
- `GET /observe` with `X-Session` header — get current state

### Platforming Jump Technique (Critical!)
**Problem:** Jumping while moving into a wall doesn't work — the MoveTo pins you against the wall and the Jump never fires.

**Solution:** 
1. Back away from the wall to open ground
2. `Stop` movement
3. Send `Jump` **first** while stationary
4. Wait ~50ms, then send `MoveTo` toward the target while airborne
5. The character clears the wall in mid-air and lands on top

This is the only reliable way to jump onto elevated platforms. Jump height is ~7 units above current surface.

### Movement Notes
- Player hitbox is ~2 units wide (1 unit radius). You get blocked ~1 unit before a wall's AABB.
- Player center Y offset is ~2.55 above the surface they're standing on.
- Walk speed is 16 units/sec. Cross-map (100 units) takes ~6 seconds.
- Observe can return stale position if polled too fast — jump arc is visible only in rapid (~100-150ms) polling windows.

### Flat World Map (Structures by height)
| Structure | Position (center) | Top Y | Size |
|-----------|-------------------|-------|------|
| LowStep | (8, 1, 18) | 2 | 8x2x10 |
| SteppingStone | (-18, 1.25, -12) | 2.5 | 8x2.5x8 |
| SmallPlateau | (-30, 1, 28) | 2 | 10x2x8 |
| LargeMesa | (20, 2, 20) | 4 | 20x4x16 |
| TallMesa | (-25, 3, -20) | 6 | 12x6x10 |
| Ridge | (35, 1.5, -10) | 3 | 6x3x25 |
| TowerBase | (-28, 3.5, -26) | 7 | 8x7x8 |
| HighShelf | (25, 3.5, 28) | 7 | 10x7x8 |
| Summit | (-28, 5, -30) | 10 | 6x10x6 |
| Peak | (28, 5.5, 32) | 11 | 5x11x5 |
| **Spire** | (-30, 6.75, -33) | **13.5** | 4x13.5x4 |

### Climbing Routes
- **East route:** Ground → LowStep(2) → LargeMesa(4) → HighShelf(7) → Peak(11)
- **West route:** Ground → SteppingStone(2.5) → TallMesa(6) → TowerBase(7) → Summit(10) → Spire(13.5) 🏆
- Both routes fully verified and climbable. West route speed run: ~20s from ground.

### Speed Run Records
- **East route** (Ground → LowStep → LargeMesa → HighShelf → Peak): **9.0s** from spawn
- **West route** (Ground → SteppingStone → TallMesa → TowerBase → Summit → Spire): **9.3s** from map center
- **Spawn to Spire (optimized):** **7.6s** — tightened all sleep timings. Current PB.
- **The Full Mountain** (Peak → drop → cross map → Spire): ~12s total
- Key optimization: reduce sleep between stop/jump/move to 0.04s, reduce platform traversal sleeps to minimum needed for landing confirmation.

### World Tour Record
- **All 11 structures summited in 30.3s** — PERFECT RUN 🏆
- Route: LowStep → LargeMesa → HighShelf → Peak → (drop) → SmallPlateau → Ridge → SteppingStone → TallMesa → TowerBase → Summit → Spire
- Script: `world_tour_v3.py`
- Key learnings: approach points must be on open ground (not against walls). The `move_wait` stuck-detection is essential. SteppingStone must be approached from the east (x > -14), not from the north.

### The Void
- Walking off the platform edge = infinite freefall. No kill plane, no death, no respawn.
- Y velocity accelerates indefinitely (gravity = 196.2). Reached Y=-60,000 in ~30 seconds.
- Horizontal movement still works during freefall (MoveTo changes XZ) but you can't fight gravity.
- Jump doesn't work while not grounded. Once you're falling, you're committed.
- Only recovery: restart server and rejoin. The falling session blocks new joins ("instance is full").

### The Perimeter
- Walking the edge at X/Z ≈ ±49 is safe. Player can reach ~49.3 before hitbox hangs over void.
- Full circumnavigation (4 edges, ~400 units) takes ~25 seconds with no obstacles on the perimeter.
- The Ridge at (35, Z:-22.5 to 2.5) is the only structure near the east edge but doesn't reach it.

### Maximum Height Record
- Jumping from Spire top (surface 13.5): jump arc peaks at Y≈20.25 (player center Y≈22.8)
- This is the absolute highest reachable point in the world — 20.25 units above ground.
- The jump arc from Spire clears the Summit entirely, allowing a "Summit Skip" landing directly on TowerBase.

### Descent Technique: The Spire Drop
- Walk off edges without jumping to chain-descend: Spire → Summit → TowerBase → TallMesa → SteppingStone → Ground
- The route naturally catches you on each platform below. No fall damage in this game.
- SteppingStone acts as an unintentional safety net between TallMesa and ground.

### Gotchas & Bugs
- **LowStep → LargeMesa transition:** They share an edge (LowStep x goes to 12, LargeMesa x starts at 10). If you walk toward LargeMesa from LowStep, you get pinned at x≈9 against the wall. Must back away to x≈6 on LowStep before jumping.
- **Ridge corner trap:** Landing near the Ridge at z≈3.5 (just outside the z=2.5 edge) can freeze the player completely. Jump doesn't work, MoveTo to nearby points doesn't work. Fix: MoveTo a distant point (e.g., [35, 0, 10]) — it takes ~2 seconds to "wake up" but eventually works.
- **Instance is full:** Server only allows one player. Can't rejoin while a frozen session exists — must unstick the existing one.
- **Cross-map jumps don't work:** From Peak (Y=11) to Ridge (Z=-10), it's ~43 units horizontal. Walk speed is 16 u/s and fall time from 11→0 is ~1s. Max horizontal distance while falling is ~16 units. You'll land on the ground short.
