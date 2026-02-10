# Maze Runner

Navigate a procedurally generated 10x10 maze. Collect glowing orbs for bonus points and reach the goal as fast as possible.

## Actions

### MoveTo
Walk to a position in the maze.

```json
{"type": "MoveTo", "data": {"position": [x, y, z]}}
```

## Observations

### Player Attributes
| Attribute | Type | Description |
|-----------|------|-------------|
| `Score` | number | Current score |
| `OrbsCollected` | number | Orbs picked up so far |
| `Finished` | boolean | True when the goal is reached |
| `CompletionTime` | number | Seconds to finish (set on completion) |
| `MazeRows` | number | Grid rows (10) |
| `MazeCols` | number | Grid columns (10) |
| `CellSize` | number | Cell size in studs (10) |
| `GoalRow` | number | Goal cell row (10) |
| `GoalCol` | number | Goal cell column (10) |

### World Entities
- `Orb_N` — Golden collectible orbs (Ball, Neon). Disappear on pickup.
- `Goal` — Cyan neon cylinder at the destination cell.
- `GoalBeam` — Tall neon pillar above the goal (visible over walls).
- `GameState` (Folder) — `Phase`, `ElapsedTime`, `TotalOrbs`.

### Static Map (via /map endpoint)
- `Floor` — 106x106 stud concrete floor.
- `Walls/Wall_N` — Blue-gray concrete walls (height 8, thickness 1).
- `StartPad` — Green neon cylinder at cell (1,1).
- `Torch` — Orange neon cubes at dead-end cells.
- `Junction` — Blue neon floor discs at T-junctions and crossroads.

## Map
- 10x10 procedural maze, 100x100 studs, centered at origin.
- Each cell is 10x10 studs. Walls are 8 studs tall.
- Player spawns at cell (1,1) — top-left corner.
- Goal at cell (10,10) — bottom-right corner.

## Scoring
- Each orb collected: **+100 pts**
- Reaching the goal: **+500 pts**
- Time bonus: **max(0, 1000 - seconds*5) pts**

## Strategy
1. Fetch the map once to learn wall positions.
2. Build a graph: cells are nodes, open walls are edges.
3. Compute shortest path from (1,1) to (10,10).
4. Optionally detour through nearby orbs if the path cost is small.
5. Issue MoveTo commands to each cell center along the path.
