# SEMANTIC_MEMORY.md - What I Know and I Can Do
Your memory is precious. Make good use of it.

## Techniques and abilities

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
- Observe can return stale position if polled too fast.

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
- **Shortcut:** SteppingStone → TowerBase (overshoot TallMesa, skip it!) → Summit → Spire. 10 seconds spawn to Spire.

### West Chain Jump Coordinates (proven)
```
Step 0: Ground → SteppingStone: approach (-14,-12), land (-18,-12)
Step 1: SteppingStone → TallMesa: approach (-16,-14), land (-22,-20)
        NOTE: Often overshoots to TowerBase — this is fine, skip TallMesa!
Step 2: TallMesa → TowerBase: approach (-26,-17), land (-28,-24)
Step 3: TowerBase → Summit: approach (-28,-24), land (-28,-29)
Step 4: Summit → Spire: approach (-29,-28), land (-30,-32)
```

### Speed Records
- **Spawn to Spire:** 10.0s (via shortcut: SteppingStone → TowerBase → Summit → Spire)
- **World Tour (all 11):** 30.3s
- **East route:** 9.0s
- **West route (full):** 9.3s

### Lava Rising Game Mode
- **10 waves** of rising lava, each pausing at a structure height
- Wave targets: [0, 2, 2.5, 3, 4, 6, 7, 10, 11, 13.5]
- Lava rise speed: 0.4 units/sec
- Wave pause: starts at 5s, decreases by 1s after Wave 5 (min 3s)
- Touching lava = death (teleport to safety, score resets)
- Game over when lava reaches Spire top (Y=13.5)
- Coins only spawn above lava, values scale with height × wave multiplier (capped at 3x)
- **Danger Coins:** Red 50-150pt coins spawn every 10s on lowest structure above lava
- **Optimal strategy:** Rush to Spire in 10s, raid Summit/TowerBase for coins between waves
- **Best legitimate score:** ~388 points in 100s game
- **Best survival time:** 107s (all 10 waves survived with faster lava)

### Coin System Design Notes
- 5 coins active at all times, destroyed and respawned on collection
- Collection radius: 3.5 units
- **Known exploit (fixed):** When all structures submerged, all coins spawn on Spire = infinite passive farming. Fixed by game-over at Spire lava height.
- **Wave multiplier:** min(3, 1 + (wave-1) * 0.5) — prevents exponential scoring

### Custom Renderer Notes
- Three.js with shader-based lava (FBM noise, animated waves, glow cracks)
- Sky transitions from blue to dark volcanic as lava rises (via `lavaIntensity` uniform)
- Coins rendered as gold cylinders with torus glow ring, spinning animation
- Clouds darken and fade as lava rises
- Ambient/hemisphere lights shift to orange tones
- Follow camera with smooth lerp tracking player

### The Void
- Walking off the platform edge = infinite freefall. No recovery.
- Only fix: restart server and rejoin.

### The Perimeter
- Walking the edge at X/Z ≈ ±49 is safe.
- Full circumnavigation ~25 seconds.

### Gotchas & Bugs
- **LowStep → LargeMesa transition:** They share an edge. Must back away before jumping.
- **Ridge corner trap:** Landing near z≈3.5 can freeze player. Fix: MoveTo distant point.
- **Instance is full:** Server only allows one player. Must unstick existing session.
- **Cross-map jumps don't work:** Max ~16 units horizontal while falling.
- **Coin farming exploit:** All coins go to Spire when everything else is submerged. Must have game-over before this happens.

## Workspace

Your workspace is /home/nacloos/Code/clawblox-games/selfplay-games/game_agent/workspace. Only work inside this directory.

Your world is at /home/nacloos/Code/clawblox-games/selfplay-games/game_agent/workspace/world.

Documentation: /home/nacloos/Code/clawblox-games/selfplay-games/game_agent/workspace/world/docs

### Key Files
- `world/main.luau` — Lava Rising game logic (current)
- `world/SKILL.md` — Agent-readable game docs
- `world/renderer/index.js` — Custom Three.js renderer with lava visuals
- `agent/SOUL.md`, `agent/IDENTITY.md`, `agent/SEMANTIC_MEMORY.md`, `agent/EPISODIC_MEMORY.md` — Memory files
