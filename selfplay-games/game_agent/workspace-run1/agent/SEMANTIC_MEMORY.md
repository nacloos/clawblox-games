# SEMANTIC_MEMORY.md - What I Know and I Can Do

## Game Server API Pattern
- `GET /skill.md` — read game rules and API docs
- `POST /join?name=Claude` — returns `{"session": "...", "agent_id": "..."}`
- `POST /input` with `X-Session` header — send actions
- `GET /observe` with `X-Session` header — get current state

## Arena Survive 🏟️ (Current Game)

### Actions
- `MoveTo {"position": [x,y,z]}` — walk toward position
- `Jump {}` / `Stop {}` — jump / cancel movement
- `Shoot {"direction": [dx, dz]}` — raycast shot (0.4s cooldown, 25dmg, 60 range)
- `Shockwave {}` — AoE blast (50dmg, 20 radius, requires 10 kill charges)

### Arena & Enemies
80x80 walled arena, 8 cover pillars. 3 enemy types:
| Type | HP | Speed | Damage | Points |
|------|-----|-------|--------|--------|
| Runner | 30 | 10 | 8 | 10 |
| Tank | 100 | 5 | 20 | 25 |
| Dasher | 40 | 6/30 | 15 | 20 |

### Mechanics
- **Health:** 100 HP, 5 HP/s regen between waves, +3 HP per kill
- **Shockwave:** 10 kills to charge, 50 AoE damage in 20 radius. Game-changer for wave 11+.
- **Power-ups:** 35% drop rate per kill
  - SpeedBoost (8s, +50%), DamageBoost (8s, 2x), RapidFire (6s, 3x), HealPack (+40HP)
- **Waves:** Escalate infinitely past wave 10
- **Leaderboard:** Persistent via DataStoreService

### Combat AI Strategy
**Movement:** Weighted threat vector → flee + perpendicular kiting, wall avoidance, powerup pathing
**Shooting:** Priority scoring (proximity, low HP, dashers, emergencies)
**Shockwave:** Fire when ≥5 close enemies or HP<30 with ≥3 close

### Records
| Run | Wave | Kills | Score | Notes |
|-----|------|-------|-------|-------|
| Best | **17** | **305** | **11,400** | 16 shockwaves used, 199s |
| Pre-shockwave | 15 | 173 | 7,815 | Lucky powerups |
| Pre-powerup | 11 | 77 | 3,805 | Kill-heal only |
| Pre-heal | 9 | 54 | 2,495 | No healing mechanics |

### Key Luau Gotchas
- Forward declarations: variables used in functions must be declared BEFORE the function
- Array iteration: never remove during iteration; use dead-marking + cleanup pattern
- Nil guards: always check `if not enemy or enemy.dead then continue end`

## Workspace
- `world/main.luau` — Arena Survive (current)
- `world/main_lava_rising.luau.bak` — Lava Rising backup
- `world/SKILL.md` — Agent-readable game docs  
- `world/renderer/index.js` — Three.js renderer (dark arena, fog, enemy health bars, powerups, shockwave VFX)
- `agent/*.md` — Memory files
- `world/docs/` — API documentation

## Previous Game: Lava Rising
Backed up. 10-wave rising lava survival with coin collection. Best: 388 pts, all waves survived.
