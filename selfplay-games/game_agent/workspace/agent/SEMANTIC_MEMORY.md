# SEMANTIC_MEMORY.md - What I Know and I Can Do

## Physics & Movement
- Walk speed: 16, Jump power: 50, Gravity: 196.2
- Player hitbox: 2x5x2 (cylinder), center at Y=2.55 when grounded (feet at ~0.05)
- Jump clears 3-5 unit height gaps easily
- Falling off the 100x100 platform = infinite fall (no respawn observed)

## Key Technique: Running Jump (UPDATED Session 2)
- **MoveTo target first**, then **Jump 50ms later** — near-simultaneous but MoveTo must come first
- The horizontal velocity carries you in a parabolic arc over the edge
- Jumping from standstill then issuing MoveTo does NOT work — MoveTo kills vertical velocity
- If too much delay (200ms+), you hit the wall before jumping and get stuck
- **Sweet spot: 50ms gap between MoveTo and Jump**
- Jump power (50) easily clears 2-7 unit heights with this technique

## World Map
- 100x100 teal platform, Y=0 surface, centered at origin
- **SW Parkour Chain** (COMPLETED Session 1): SteppingStone(2.5) → TallMesa(6) → TowerBase(7) → Summit(10) → Spire(13.5)
- **NE Parkour Chain** (COMPLETED Session 2): LowStep(2) → LargeMesa(4) → HighShelf(7) → Peak(11)
- **Isolated** (COMPLETED Session 3): SmallPlateau(2) at (-30,28), Ridge(3) at (35,-10)
- **ALL 11 structures summited** — 100% map completion

## Structure Quick Reference
| Name | Center (X,Z) | Top Y | Size |
|------|--------------|-------|------|
| LowStep | (8, 18) | 2 | 8x10 |
| LargeMesa | (20, 20) | 4 | 20x16 |
| SmallPlateau | (-30, 28) | 2 | 10x8 |
| SteppingStone | (-18, -12) | 2.5 | 8x8 |
| Ridge | (35, -10) | 3 | 6x25 |
| TallMesa | (-25, -20) | 6 | 12x10 |
| HighShelf | (25, 28) | 7 | 10x8 |
| TowerBase | (-28, -26) | 7 | 8x8 |
| Summit | (-28, -30) | 10 | 6x6 |
| Peak | (28, 32) | 11 | 5x5 |
| Spire | (-30, -33) | 13.5 | 4x4 |