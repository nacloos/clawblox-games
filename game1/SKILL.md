# Crystal Climb: Sky Realms

A vertical obstacle course adventure through 4 themed sky islands. Collect crystals, survive hazards, and reach the summit!

## Objective

Climb from the Forest Grove at ground level to the Sky Castle summit at Y=185+. Collect as many crystals as possible for maximum score. Reach checkpoints to save your progress. The fastest completion with the most crystals wins.

## Actions

### MoveTo
Move to a position on the map. Your character will walk toward the target.
```json
{"type": "MoveTo", "data": {"position": [x, y, z]}}
```

### Jump
Make your character jump. Use this to reach higher platforms.
```json
{"type": "Jump", "data": {}}
```

### Collect
Collect the nearest crystal within 5 studs radius. Crystals are also auto-collected when you walk near them.
```json
{"type": "Collect", "data": {}}
```

### GetLeaderboard
Print the current leaderboard to console.
```json
{"type": "GetLeaderboard", "data": {}}
```

## Observations

Player attributes visible in observations:
- `Score` - Total points earned
- `Crystals` - Number of crystals collected
- `TotalCrystals` - Total crystals in the game
- `Zone` - Current zone number (1-4)
- `ZoneName` - Current zone name
- `Checkpoint` - Last checkpoint reached (1-5)
- `Deaths` - Number of deaths
- `TimeElapsed` - Seconds since joining
- `ReachedSummit` - Whether player reached the top

## Map Layout

The map is a vertical tower of 4 themed zones, each ~40 studs tall. Platforms zigzag upward. Z-axis generally increases as you progress forward within each zone.

### Zone 1: Forest Grove (Y: 0 to ~30)
- Start position: (0, 5, -7)
- Wide grassy platforms, easy jumps
- Trees, mushrooms, and rocks as scenery
- 6 crystals (1 hidden bonus off the main path at X=-20)
- Jump pad at (5, 18, 68) launches you to the next zone

### Zone 2: Lava Caverns (Y: 45 to ~83)
- Lava floor below Y=40 is instant death
- Narrow bridges, moving platforms that slide on X-axis
- 6 crystals (1 hidden behind a column at X=-15)
- Jump pad at (8, 70, 65) launches to ice zone

### Zone 3: Frozen Peaks (Y: 95 to ~143)
- Disappearing platforms that phase in/out every 3 seconds
- Narrow ice bridges in zigzag pattern
- Vertically moving platforms
- 7 crystals (1 hidden at X=18 off the main path)
- Jump pad at (0, 134, 90) to sky castle

### Zone 4: Sky Castle (Y: 145 to ~195)
- Smallest platforms, largest gaps
- Combined moving + disappearing platforms
- Narrow bridge with kill bricks on both edges
- 7 crystals (1 hidden at X=-25 on a tiny platform)
- 10-point summit crystal on the golden platform
- Treasure chest and crown at the summit

## Scoring

| Action | Points |
|--------|--------|
| Regular crystal | value x 100 |
| Hidden crystal | value x 3 x 100 |
| Checkpoint reached | zone_index x 200 |
| Summit reached | 1000 + time bonus |
| Time bonus | max(0, 5000 - seconds x 5) |

Crystal values increase per zone: Forest=1-2, Lava=2-3, Ice=3-4, Sky=4-10.

## Hazards

- **Kill Bricks** (red/orange neon): Instant death, respawn at last checkpoint
- **Lava Floor** (Zone 2): Y < 40 in lava zone is death
- **Void**: Falling below Y=-20 is death
- **Disappearing Platforms** (Zone 3-4): Phase out every ~3 seconds
- **Moving Platforms** (Zone 2-4): Slide back and forth on their axis

## Checkpoints

5 checkpoints save your respawn position:
1. Spawn (0, 5, -7)
2. Forest End (0, 36, 83)
3. Lava End (0, 86, 78)
4. Ice End (0, 148, 103)
5. Summit (0, 188, 106)

## Strategy Tips

1. Navigate forward (increasing Z) and upward (increasing Y) through each zone
2. Watch for hidden crystals on small platforms off the main path
3. Time your jumps on disappearing platforms - they alternate every 3 seconds
4. Moving platforms follow a sine wave pattern - wait for them to come to you
5. In the Lava zone, stay on platforms at all costs
6. The narrow bridge in Sky Castle has kill bricks on both sides - stay centered
7. Speed matters for the time bonus, but collecting crystals is worth more
8. Jump pads are bright yellow - step on them to launch to the next zone
