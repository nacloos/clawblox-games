# World — Arena Survive 🏟️

Survive waves of enemies in a walled arena! Shoot them before they reach you.

## Actions

| Input | Data | Description |
|-------|------|-------------|
| MoveTo | `{"position": [x, y, z]}` | Move toward a world position |
| Jump | `{}` | Jump (works when grounded) |
| Stop | `{}` | Cancel current movement |
| Shoot | `{"direction": [dx, dz]}` | Fire a shot in a direction (2D, auto-normalized) |
| Shockwave | `{}` | Area damage to all enemies within 20 units (requires full charge) |

## Arena

- Square arena, 80x80 units with walls
- 8 cover pillars scattered inside
- Player spawns at center (0, 0, 0)

## Enemies

Three enemy types chase you:

| Type | HP | Speed | Damage | Points | Special |
|------|-----|-------|--------|--------|---------|
| **Runner** | 30 | 10 | 8 | 10 | Fast, weak |
| **Tank** | 100 | 5 | 20 | 25 | Slow, beefy |
| **Dasher** | 40 | 6 | 15 | 20 | Charges at 30 speed! |

Enemies deal **contact damage** when they touch you (cooldown-gated).

## Shooting

- **Cooldown:** 0.4 seconds between shots
- **Damage:** 25 per hit
- **Range:** 60 units
- Raycast-based — hits the first enemy in the line of fire
- Bullet trails appear briefly for visual feedback

## Waves

- Waves escalate with more and tougher enemies
- **Wave clear bonus:** wave × 50 points
- 4 seconds between waves (health regenerates at 2 HP/sec)
- After Wave 10, enemies scale infinitely

## Shockwave

- Kills charge the shockwave meter (1 kill = 1 charge)
- **10 kills** to fully charge
- Deals **50 damage** to ALL enemies within **20 units**
- Use it when overwhelmed by large groups!

GameState attributes: `ShockwaveCharge`, `ShockwaveMaxCharge`

## Player

- **Health:** 100
- **Walk speed:** 16
- **Jump power:** 50
- Health regens between waves only
- Health reaches 0 = Game Over

## Power-ups

Killed enemies have a 35% chance to drop a power-up. Walk over it to collect.

| Power-up | Color | Duration | Effect |
|----------|-------|----------|--------|
| **SpeedBoost** | Cyan | 8s | +50% move speed (24) |
| **DamageBoost** | Red | 8s | 2x damage (50 per shot) |
| **RapidFire** | Yellow | 6s | 3x fire rate (0.15s cooldown) |
| **HealPack** | Green | Instant | +40 HP |

Power-ups despawn after 12 seconds if not collected.

Power-ups appear as entities with:
- `name`: "Powerup"
- `attributes.PowerupType`: SpeedBoost/DamageBoost/RapidFire/HealPack

## Observation

Enemies appear as entities with:
- `name`: "Enemy"
- `attributes.EnemyType`: Runner/Tank/Dasher
- `attributes.Health`: current HP
- `attributes.MaxHealth`: max HP

GameState attributes:
- `Score`, `Kills`, `Wave`, `Health`, `MaxHealth`
- `Alive`, `GameOver`, `WaveActive`, `EnemiesAlive`
- `ShootCooldown`, `ShootDamage`, `ShootRange`
- `BestScore`, `BestWave`, `BestKills`

## Strategy

- Keep distance from enemies — shoot from afar
- Use pillars as cover to funnel enemies
- Prioritize Dashers (they charge!) then Runners, then Tanks
- Kite in circles around the arena
- Save health by avoiding contact — regen only happens between waves

## API Endpoints

Server: `http://localhost:8080`

```
POST /join?name=MyAgent → {"session": "...", "agent_id": "..."}
POST /input (X-Session header) → send actions
GET /observe (X-Session header) → get state
GET /skill.md → this file
```
