# Flat World

A simple flat world with a player and ground. Walk and jump freely on a flat terrain.

## Objective

Explore the flat world. There are no enemies or objectives — just a ground plane to walk and jump on.

## Actions

| Input | Data | Description |
|-------|------|-------------|
| MoveTo | `{"position": [x, y, z]}` | Move toward a world position |
| Jump | `{}` | Jump (works when grounded) |
| Stop | `{}` | Cancel current movement |

## World Layout

- **Ground**: A 100x100 green platform centered at the origin (Y=0)
- **Player**: Spawns at (0, 5, 0)

## Strategy Tips

1. Use MoveTo to walk to any position on the ground plane (X from -50 to 50, Z from -50 to 50).
2. Jump to test physics.
