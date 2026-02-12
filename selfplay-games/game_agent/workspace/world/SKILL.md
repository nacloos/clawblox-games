# World — Lava Rising 🌋

The floor is lava! A glowing lava plane rises in waves, swallowing structures from lowest to highest. Collect coins on the remaining safe platforms. Survive as long as you can.

## Actions

| Input | Data | Description |
|-------|------|-------------|
| MoveTo | `{"position": [x, y, z]}` | Move toward a world position |
| Jump | `{}` | Jump (works when grounded) |
| Stop | `{}` | Cancel current movement |

## Lava

- Lava starts below the ground and begins rising after 5 seconds
- Rises in **waves** — pauses briefly at each structure height before continuing
- Touching lava = death (teleported to safety, score reset)
- Structures below the lava are submerged — you can't stand on them
- Later waves rise faster with shorter pauses

## Wave Heights
1. Ground (Y=0)
2. LowStep / SmallPlateau (Y=2)
3. SteppingStone (Y=2.5)
4. Ridge (Y=3)
5. LargeMesa (Y=4)
6. TallMesa (Y=6)
7. TowerBase / HighShelf (Y=7)
8. Summit (Y=10)
9. Peak (Y=11)
10. Spire (Y=13.5)
11. GAME OVER (Y=16) — lava covers everything, game ends

## Coins

- **5 coins** always active, only on structures above the lava
- Walk near a coin (within 3.5 units) to collect it
- **Point values** = height bonus × wave multiplier (higher waves = bigger scores)
- Coins below the lava are automatically destroyed
- Collected coins are instantly replaced

## Danger Coins 💎

- A **red danger coin** spawns every 10 seconds on the lowest structure still above the lava
- Worth **50-150 points** (scaled by wave) — 5-10× more than normal coins
- Bigger collection radius (4 units)
- High risk, high reward — you need to descend toward the lava to get them
- If the lava swallows the structure, the danger coin is destroyed

## Observation

Coins appear as entities with:
- `name`: "Coin"
- `attributes.Location`: which structure
- `attributes.Points`: point value

Lava entity:
- `name`: "Lava"
- `attributes.LavaY`: current lava height

Player attributes:
- `Score`, `CoinsCollected`, `LastCoinLocation`, `LastCoinPoints`, `Alive`

GameState:
- `Score`, `CoinsCollected`, `GameTime`, `LavaY`, `Wave`, `Alive`
- `BestScore`, `BestWave`, `BestSurvivalTime`

## Physics

- Gravity: 196.2
- Walk speed: 16
- Jump power: 50
- Jump height: ~7 units above current surface
- Falling off the edge = infinite freefall (no recovery)

## Strategy

- Start collecting ground coins immediately — they'll be gone in ~20 seconds
- As lava rises, route to higher structures using climbing chains
- **East route:** LowStep → LargeMesa → HighShelf → Peak
- **West route:** SteppingStone → TallMesa → TowerBase → Summit → Spire
- The Spire (Y=13.5) is your last refuge

## API Endpoints

Server: `http://localhost:8080`

```
POST /join?name=MyAgent → {"session": "...", "agent_id": "..."}
POST /input (X-Session header) → send actions
GET /observe (X-Session header) → get state
GET /skill.md → this file
```
