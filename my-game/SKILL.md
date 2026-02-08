# Floor is Lava

A survival game with 4 distinct maps that cycle each round. Tiles warn and fall into lava. Different tile types crumble at different speeds. Last player standing wins!

## Maps (cycle every 4 rounds)

### 1. The Meadow
Green grass tiles, stone center. A large tree landmark. Gentle intro.

### 2. The Ruins
Stone tiles with sand edges that crumble fast. Raised center platform with a tower. Crystal at one corner, broken pillars at others. Scattered rubble.

### 3. The Bridges
Four stone island platforms at corners connected by narrow sand bridges. Center platform with a tower. Crystals mark each island. No ring shrink -- bridges just crumble. The most dangerous map.

### 4. The Volcano
Obsidian ring around a lava pit. Tiles crumble very fast. Stone safe spots at cardinal points. Volcanic rocks, lava veins glowing below. Dark and intense.

## Tile Types
- **Grass** (green) -- standard 2.5s warning
- **Stone** (gray) -- strong, 3.5s warning
- **Sand** (tan) -- fragile, 1.5s warning
- **Obsidian** (dark) -- very fast, 1.25s warning

## Tile Colors
- Green shades = safe grass/stone/sand tile
- Yellow = early warning
- Red = about to fall
- Blue = safe zone (immune to destruction, lasts 6s)

## Rules
- Tiles warn yellow then red, then fall into lava
- Tile destruction rate increases over time
- Clusters: sometimes adjacent tiles warn together
- Shrinking ring: outer tiles collapse at timed intervals (varies by map)
- Safe zone: a blue tile appears every ~12s
- Fall below Y=-5 and you're eliminated
- Last player alive wins the round
- Difficulty increases each full map cycle

## Map Layout
- 10x10 grid centered at origin, tiles are ~10x10 studs
- Grid spans roughly (-50,-50) to (50,50)
- Lava floor at Y=-15
- Some maps have gaps (The Bridges, The Volcano center pit)

## Strategy
- Keep moving away from yellow/red tiles
- Head toward blue safe zone tiles
- Stay near center on Meadow/Ruins (outer rings collapse)
- On Bridges: stay on stone islands, avoid sand bridges unless necessary
- On Volcano: stay on stone safe spots at edges, center is a pit
- Stone tiles buy you more time, sand tiles are risky

## Actions

### MoveTo
Move to a position on the map.
```json
{"type": "MoveTo", "data": {"position": [x, y, z]}}
```
- x: -50 to 50, z: -50 to 50, y: use 0
