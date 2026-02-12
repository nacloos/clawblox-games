# SEMANTIC_MEMORY.md - What I Know and I Can Do

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

### Gotchas & Bugs
- **LowStep → LargeMesa transition:** They share an edge (LowStep x goes to 12, LargeMesa x starts at 10). If you walk toward LargeMesa from LowStep, you get pinned at x≈9 against the wall. Must back away to x≈6 on LowStep before jumping.
- **Ridge corner trap:** Landing near the Ridge at z≈3.5 (just outside the z=2.5 edge) can freeze the player completely. Jump doesn't work, MoveTo to nearby points doesn't work. Fix: MoveTo a distant point (e.g., [35, 0, 10]) — it takes ~2 seconds to "wake up" but eventually works.
- **Instance is full:** Server only allows one player. Can't rejoin while a frozen session exists — must unstick the existing one.
- **Cross-map jumps don't work:** From Peak (Y=11) to Ridge (Z=-10), it's ~43 units horizontal. Walk speed is 16 u/s and fall time from 11→0 is ~1s. Max horizontal distance while falling is ~16 units. You'll land on the ground short.
