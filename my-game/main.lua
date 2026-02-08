-- Floor is Lava - Multi-Map Survival Game
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local AgentInputService = game:GetService("AgentInputService")

--------------------------------------------------------------------------------
-- CONFIGURATION
--------------------------------------------------------------------------------

local MAP_SIZE = 100
local TILE_HEIGHT = 3
local WARNING_DURATION = 2.5
local FALL_THRESHOLD = -5
local ROUND_RESTART_DELAY = 6
local INITIAL_TICK_INTERVAL = 1.8
local MIN_TICK_INTERVAL = 0.25
local RAMP_RATE = 0.04
local CLUSTER_CHANCE = 0.2
local SAFE_ZONE_INTERVAL = 12
local SAFE_ZONE_DURATION = 6
local SHRINK_TIMES = {22, 36, 48}

--------------------------------------------------------------------------------
-- GAME STATE
--------------------------------------------------------------------------------

local tiles = {}           -- [key] = {part, row, col, tileType}
local warningTiles = {}
local playerData = {}
local roundActive = false
local roundNumber = 0
local tickInterval = INITIAL_TICK_INTERVAL
local tickTimer = 0
local roundEndTimer = nil
local roundTimer = 0
local tilesRemaining = 0
local shrinkIndex = 1
local currentRing = 0
local currentMapIndex = 0

-- Safe zone
local safeTileKey = nil
local safeTileTimer = 0
local safeTileSpawnTimer = 0

-- Persistent scenery
local sceneryParts = {}
-- Per-round decorations (destroyed between rounds)
local roundDecorations = {}

--------------------------------------------------------------------------------
-- TILE TYPES
--------------------------------------------------------------------------------

local TILE_TYPES = {
    grass = {
        warningDuration = WARNING_DURATION,
        color1 = Color3.fromRGB(75, 190, 75),
        color2 = Color3.fromRGB(95, 165, 85),
    },
    stone = {
        warningDuration = WARNING_DURATION * 1.4,  -- slower to crumble
        color1 = Color3.fromRGB(140, 140, 150),
        color2 = Color3.fromRGB(120, 120, 130),
    },
    sand = {
        warningDuration = WARNING_DURATION * 0.6,  -- crumbles fast
        color1 = Color3.fromRGB(210, 190, 130),
        color2 = Color3.fromRGB(195, 175, 120),
    },
    obsidian = {
        warningDuration = WARNING_DURATION * 0.5,  -- very fast
        color1 = Color3.fromRGB(60, 50, 65),
        color2 = Color3.fromRGB(75, 55, 50),
    },
}

--------------------------------------------------------------------------------
-- MAP DEFINITIONS
--------------------------------------------------------------------------------

-- Each map defines: name, grid layout, tile types, decorations, lava color, wall color
-- Grid: 10x10. Values: nil = no tile, "grass"/"stone"/"sand"/"obsidian" = tile type
-- Heights: optional height overrides per tile

local function fullGrid(tileType)
    local grid = {}
    for r = 1, 10 do
        grid[r] = {}
        for c = 1, 10 do
            grid[r][c] = tileType
        end
    end
    return grid
end

local MAPS = {}

-- MAP 1: THE MEADOW
-- Simple open field with a large tree in the center. Gentle intro.
MAPS[1] = {
    name = "The Meadow",
    lavaColor = Color3.fromRGB(220, 60, 10),
    wallColor = Color3.fromRGB(80, 100, 60),
    grid = (function()
        local g = fullGrid("grass")
        -- Center 2x2 is stone (harder to destroy)
        g[5][5] = "stone"
        g[5][6] = "stone"
        g[6][5] = "stone"
        g[6][6] = "stone"
        return g
    end)(),
    heights = {},
    decorations = function()
        local parts = {}

        -- Tree in the center
        local tree = Instance.new("Part")
        tree.Name = "AncientTree"
        tree.Size = Vector3.new(6, 12, 6)
        tree.Position = Vector3.new(0, TILE_HEIGHT + 6, 0)
        tree.Anchored = true
        tree.CanCollide = false
        tree.Transparency = 1
        tree:SetAttribute("ModelUrl", "asset://models/tree.glb")
        tree.Parent = Workspace
        table.insert(parts, tree)

        -- Boulders scattered around
        local boulderSpots = {
            Vector3.new(-30, TILE_HEIGHT + 1.5, -30),
            Vector3.new(35, TILE_HEIGHT + 1.5, 20),
            Vector3.new(-20, TILE_HEIGHT + 1.5, 35),
            Vector3.new(25, TILE_HEIGHT + 1.5, -35),
        }
        for i, pos in ipairs(boulderSpots) do
            local b = Instance.new("Part")
            b.Name = "Boulder_" .. i
            b.Size = Vector3.new(4, 4, 4)
            b.Position = pos
            b.Anchored = true
            b.CanCollide = false
            b.Transparency = 1
            b:SetAttribute("ModelUrl", "asset://models/boulder.glb")
            b.Parent = Workspace
            table.insert(parts, b)
        end

        -- Mushrooms near the tree
        local mushSpots = {
            Vector3.new(8, TILE_HEIGHT + 1.5, 5),
            Vector3.new(-6, TILE_HEIGHT + 1.5, -8),
        }
        for i, pos in ipairs(mushSpots) do
            local m = Instance.new("Part")
            m.Name = "Mushroom_" .. i
            m.Size = Vector3.new(3, 4, 3)
            m.Position = pos
            m.Anchored = true
            m.CanCollide = false
            m.Transparency = 1
            m:SetAttribute("ModelUrl", "asset://models/mushroom.glb")
            m.Parent = Workspace
            table.insert(parts, m)
        end

        -- Small rocks (simple colored parts, no model needed)
        for i = 1, 8 do
            local r = Instance.new("Part")
            r.Name = "Rock_" .. i
            r.Shape = Enum.PartType.Ball
            r.Size = Vector3.new(1.5, 1.2, 1.5)
            r.Position = Vector3.new(
                math.random(-40, 40),
                TILE_HEIGHT + 0.6,
                math.random(-40, 40)
            )
            r.Anchored = true
            r.CanCollide = false
            r.Color = Color3.fromRGB(
                math.random(80, 120),
                math.random(90, 130),
                math.random(70, 100)
            )
            r.Parent = Workspace
            table.insert(parts, r)
        end

        return parts
    end,
    shrinkTimes = {25, 40, 50},
    tickStart = INITIAL_TICK_INTERVAL,
}

-- MAP 2: THE RUINS
-- Stone tiles, raised center platform, tower landmark, pillars at corners
MAPS[2] = {
    name = "The Ruins",
    lavaColor = Color3.fromRGB(200, 70, 20),
    wallColor = Color3.fromRGB(70, 65, 60),
    grid = (function()
        local g = fullGrid("stone")
        -- Outer ring is sand (crumbles fast on the edges)
        for r = 1, 10 do
            for c = 1, 10 do
                local edge = math.min(r - 1, c - 1, 10 - r, 10 - c)
                if edge == 0 then
                    g[r][c] = "sand"
                end
            end
        end
        return g
    end)(),
    heights = (function()
        -- Center 2x2 raised
        local h = {}
        h["5,5"] = 3
        h["5,6"] = 3
        h["6,5"] = 3
        h["6,6"] = 3
        return h
    end)(),
    decorations = function()
        local parts = {}

        -- Tower on the raised center
        local tower = Instance.new("Part")
        tower.Name = "RuinsTower"
        tower.Size = Vector3.new(8, 16, 8)
        tower.Position = Vector3.new(0, TILE_HEIGHT + 3 + 8, 0)
        tower.Anchored = true
        tower.CanCollide = false
        tower.Transparency = 1
        tower:SetAttribute("ModelUrl", "asset://models/tower.glb")
        tower.Parent = Workspace
        table.insert(parts, tower)

        -- Crystal at one corner
        local crystal = Instance.new("Part")
        crystal.Name = "Crystal"
        crystal.Size = Vector3.new(4, 6, 4)
        crystal.Position = Vector3.new(-35, TILE_HEIGHT + 3, -35)
        crystal.Anchored = true
        crystal.CanCollide = false
        crystal.Transparency = 1
        crystal:SetAttribute("ModelUrl", "asset://models/crystal.glb")
        crystal.Parent = Workspace
        table.insert(parts, crystal)

        -- Broken pillars at corners
        local pillarSpots = {
            Vector3.new(35, TILE_HEIGHT + 4, -35),
            Vector3.new(-35, TILE_HEIGHT + 4, 35),
            Vector3.new(35, TILE_HEIGHT + 4, 35),
        }
        for i, pos in ipairs(pillarSpots) do
            local p = Instance.new("Part")
            p.Name = "Pillar_" .. i
            p.Size = Vector3.new(3, 8, 3)
            p.Position = pos
            p.Anchored = true
            p.CanCollide = false
            p.Transparency = 1
            p:SetAttribute("ModelUrl", "asset://models/pillar.glb")
            p.Parent = Workspace
            table.insert(parts, p)
        end

        -- Rubble stones scattered around the ruins
        for i = 1, 6 do
            local r = Instance.new("Part")
            r.Name = "Rubble_" .. i
            r.Shape = Enum.PartType.Ball
            r.Size = Vector3.new(2, 1.5, 2)
            r.Position = Vector3.new(
                math.random(-38, 38),
                TILE_HEIGHT + 0.7,
                math.random(-38, 38)
            )
            r.Anchored = true
            r.CanCollide = false
            r.Color = Color3.fromRGB(
                math.random(100, 140),
                math.random(100, 130),
                math.random(95, 120)
            )
            r.Parent = Workspace
            table.insert(parts, r)
        end

        return parts
    end,
    shrinkTimes = {20, 32, 42},
    tickStart = INITIAL_TICK_INTERVAL * 0.9,
}

-- MAP 3: THE BRIDGES
-- Four island platforms connected by narrow 1-tile bridges. Center platform.
MAPS[3] = {
    name = "The Bridges",
    lavaColor = Color3.fromRGB(230, 50, 10),
    wallColor = Color3.fromRGB(90, 75, 55),
    grid = (function()
        local g = {}
        for r = 1, 10 do
            g[r] = {}
            for c = 1, 10 do
                g[r][c] = nil
            end
        end

        -- Four 3x3 island platforms at corners
        for _, corner in ipairs({{1,1}, {1,8}, {8,1}, {8,8}}) do
            for dr = 0, 2 do
                for dc = 0, 2 do
                    g[corner[1]+dr][corner[2]+dc] = "stone"
                end
            end
        end

        -- Center 2x2 platform
        g[5][5] = "stone"
        g[5][6] = "stone"
        g[6][5] = "stone"
        g[6][6] = "stone"

        -- Bridges (1-tile wide) connecting corners to center
        -- Top-left to center
        g[4][4] = "sand"
        -- Top-right to center
        g[4][7] = "sand"
        -- Bottom-left to center
        g[7][4] = "sand"
        -- Bottom-right to center
        g[7][7] = "sand"

        -- Bridges along edges connecting corner islands
        -- Top bridge: (1,4) to (1,7) — but row 1-3 col 4-7
        g[2][4] = "sand"
        g[2][5] = "sand"
        g[2][6] = "sand"
        g[2][7] = "sand"

        -- Bottom bridge
        g[9][4] = "sand"
        g[9][5] = "sand"
        g[9][6] = "sand"
        g[9][7] = "sand"

        -- Left bridge
        g[4][2] = "sand"
        g[5][2] = "sand"
        g[6][2] = "sand"
        g[7][2] = "sand"

        -- Right bridge
        g[4][9] = "sand"
        g[5][9] = "sand"
        g[6][9] = "sand"
        g[7][9] = "sand"

        return g
    end)(),
    heights = {},
    decorations = function()
        local parts = {}

        -- Bridge arch decorations on each bridge pathway
        local bridgePositions = {
            Vector3.new(0, TILE_HEIGHT + 2, -35),   -- top
            Vector3.new(0, TILE_HEIGHT + 2, 35),    -- bottom
            Vector3.new(-35, TILE_HEIGHT + 2, 0),   -- left
            Vector3.new(35, TILE_HEIGHT + 2, 0),    -- right
        }
        for i, pos in ipairs(bridgePositions) do
            local b = Instance.new("Part")
            b.Name = "BridgeDecor_" .. i
            b.Size = Vector3.new(4, 4, 4)
            b.Position = pos
            b.Anchored = true
            b.CanCollide = false
            b.Transparency = 1
            b:SetAttribute("ModelUrl", "asset://models/bridge.glb")
            b.Parent = Workspace
            table.insert(parts, b)
        end

        -- Crystal beacons on each island corner
        local islandCenters = {
            Vector3.new(-35, TILE_HEIGHT + 3, -35),
            Vector3.new(-35, TILE_HEIGHT + 3, 35),
            Vector3.new(35, TILE_HEIGHT + 3, -35),
            Vector3.new(35, TILE_HEIGHT + 3, 35),
        }
        for i, pos in ipairs(islandCenters) do
            local c = Instance.new("Part")
            c.Name = "IslandCrystal_" .. i
            c.Size = Vector3.new(3, 5, 3)
            c.Position = pos
            c.Anchored = true
            c.CanCollide = false
            c.Transparency = 1
            c:SetAttribute("ModelUrl", "asset://models/crystal.glb")
            c.Parent = Workspace
            table.insert(parts, c)
        end

        -- Center tower on center platform
        local centerTower = Instance.new("Part")
        centerTower.Name = "CenterTower"
        centerTower.Size = Vector3.new(5, 10, 5)
        centerTower.Position = Vector3.new(0, TILE_HEIGHT + 5, 0)
        centerTower.Anchored = true
        centerTower.CanCollide = false
        centerTower.Transparency = 1
        centerTower:SetAttribute("ModelUrl", "asset://models/tower.glb")
        centerTower.Parent = Workspace
        table.insert(parts, centerTower)

        return parts
    end,
    shrinkTimes = {},  -- no ring shrink on bridges map
    tickStart = INITIAL_TICK_INTERVAL * 0.85,
}

-- MAP 4: THE VOLCANO
-- Ring-shaped map. Center is already lava. Dark, fast, intense.
MAPS[4] = {
    name = "The Volcano",
    lavaColor = Color3.fromRGB(255, 80, 0),
    wallColor = Color3.fromRGB(50, 40, 35),
    grid = (function()
        local g = {}
        for r = 1, 10 do
            g[r] = {}
            for c = 1, 10 do
                -- Ring: no center tiles (3x3 center hole)
                local dr = math.abs(r - 5.5)
                local dc = math.abs(c - 5.5)
                if dr <= 1.5 and dc <= 1.5 then
                    g[r][c] = nil  -- lava pit in center
                else
                    g[r][c] = "obsidian"
                end
            end
        end
        -- A few stone tiles as slightly safer spots
        g[1][5] = "stone"
        g[1][6] = "stone"
        g[10][5] = "stone"
        g[10][6] = "stone"
        g[5][1] = "stone"
        g[6][1] = "stone"
        g[5][10] = "stone"
        g[6][10] = "stone"
        return g
    end)(),
    heights = {},
    decorations = function()
        local parts = {}

        -- Volcanic rocks around the edges (large, dramatic)
        local rockPositions = {
            Vector3.new(-40, -8, -40),
            Vector3.new(40, -8, 40),
            Vector3.new(-40, -8, 40),
            Vector3.new(40, -8, -40),
        }
        for i, pos in ipairs(rockPositions) do
            local rock = Instance.new("Part")
            rock.Name = "VolcanicRock_" .. i
            rock.Size = Vector3.new(10, 10, 10)
            rock.Position = pos
            rock.Anchored = true
            rock.CanCollide = false
            rock.Transparency = 1
            rock:SetAttribute("ModelUrl", "asset://models/volcano_rock.glb")
            rock.Parent = Workspace
            table.insert(parts, rock)
        end

        -- Smaller volcanic rocks along the ring
        local smallRockSpots = {
            Vector3.new(-25, TILE_HEIGHT + 1.5, 0),
            Vector3.new(25, TILE_HEIGHT + 1.5, 0),
            Vector3.new(0, TILE_HEIGHT + 1.5, -25),
            Vector3.new(0, TILE_HEIGHT + 1.5, 25),
        }
        for i, pos in ipairs(smallRockSpots) do
            local sr = Instance.new("Part")
            sr.Name = "SmallVolcanicRock_" .. i
            sr.Size = Vector3.new(4, 4, 4)
            sr.Position = pos
            sr.Anchored = true
            sr.CanCollide = false
            sr.Transparency = 1
            sr:SetAttribute("ModelUrl", "asset://models/volcano_rock.glb")
            sr.Parent = Workspace
            table.insert(parts, sr)
        end

        -- Center lava glow (bright orange part in the pit)
        local glow = Instance.new("Part")
        glow.Name = "LavaGlow"
        glow.Size = Vector3.new(25, 1, 25)
        glow.Position = Vector3.new(0, -3, 0)
        glow.Anchored = true
        glow.CanCollide = false
        glow.Color = Color3.fromRGB(255, 120, 0)
        glow.Material = Enum.Material.Neon
        glow.Parent = Workspace
        table.insert(parts, glow)

        -- Lava veins — glowing cracks on the floor
        local veinSpots = {
            {pos = Vector3.new(-20, -12, -15), size = Vector3.new(12, 0.5, 2)},
            {pos = Vector3.new(15, -12, 20), size = Vector3.new(2, 0.5, 14)},
            {pos = Vector3.new(-10, -12, 30), size = Vector3.new(8, 0.5, 2)},
            {pos = Vector3.new(25, -12, -25), size = Vector3.new(2, 0.5, 10)},
        }
        for i, v in ipairs(veinSpots) do
            local vein = Instance.new("Part")
            vein.Name = "LavaVein_" .. i
            vein.Size = v.size
            vein.Position = v.pos
            vein.Anchored = true
            vein.CanCollide = false
            vein.Color = Color3.fromRGB(255, 100, 0)
            vein.Material = Enum.Material.Neon
            vein.Parent = Workspace
            table.insert(parts, vein)
        end

        return parts
    end,
    shrinkTimes = {15, 25, 35},
    tickStart = INITIAL_TICK_INTERVAL * 0.7,
}

--------------------------------------------------------------------------------
-- HELPERS
--------------------------------------------------------------------------------

local function getHumanoid(player)
    local character = player.Character
    if character then return character:FindFirstChild("Humanoid") end
    return nil
end

local function getHRP(player)
    local character = player.Character
    if character then return character:FindFirstChild("HumanoidRootPart") end
    return nil
end

local function tileKey(row, col)
    return row .. "," .. col
end

local function getAlivePlayers()
    local alive = {}
    for _, player in ipairs(Players:GetPlayers()) do
        local data = playerData[player.Name]
        if data and data.alive then
            table.insert(alive, player)
        end
    end
    return alive
end

local function getMap()
    return MAPS[currentMapIndex]
end

local function tileRing(row, col, gridSize)
    gridSize = gridSize or 10
    return math.min(row - 1, col - 1, gridSize - row, gridSize - col)
end

--------------------------------------------------------------------------------
-- SCENERY (persistent across rounds)
--------------------------------------------------------------------------------

local function createScenery()
    if #sceneryParts > 0 then return end

    -- Lava floor
    local lava = Instance.new("Part")
    lava.Name = "LavaFloor"
    lava.Size = Vector3.new(MAP_SIZE + 40, 2, MAP_SIZE + 40)
    lava.Position = Vector3.new(0, -15, 0)
    lava.Anchored = true
    lava.Color = Color3.fromRGB(220, 60, 10)
    lava.Parent = Workspace
    table.insert(sceneryParts, lava)

    -- Arena walls
    local wallHeight = 12
    local wallThickness = 3
    local half = MAP_SIZE / 2 + wallThickness / 2
    local wallData = {
        {pos = Vector3.new(0, wallHeight / 2, -half), size = Vector3.new(MAP_SIZE + wallThickness * 2, wallHeight, wallThickness)},
        {pos = Vector3.new(0, wallHeight / 2, half), size = Vector3.new(MAP_SIZE + wallThickness * 2, wallHeight, wallThickness)},
        {pos = Vector3.new(-half, wallHeight / 2, 0), size = Vector3.new(wallThickness, wallHeight, MAP_SIZE)},
        {pos = Vector3.new(half, wallHeight / 2, 0), size = Vector3.new(wallThickness, wallHeight, MAP_SIZE)},
    }
    for _, wd in ipairs(wallData) do
        local wall = Instance.new("Part")
        wall.Name = "Wall"
        wall.Size = wd.size
        wall.Position = wd.pos
        wall.Anchored = true
        wall.Color = Color3.fromRGB(60, 60, 70)
        wall.Parent = Workspace
        table.insert(sceneryParts, wall)
    end

    -- Spectator platform
    local specPlat = Instance.new("Part")
    specPlat.Name = "SpectatorPlatform"
    specPlat.Size = Vector3.new(30, 2, 30)
    specPlat.Position = Vector3.new(0, 50, 0)
    specPlat.Anchored = true
    specPlat.Color = Color3.fromRGB(120, 120, 140)
    specPlat.Parent = Workspace
    table.insert(sceneryParts, specPlat)
end

local function updateSceneryColors(map)
    for _, part in ipairs(sceneryParts) do
        if part.Name == "LavaFloor" then
            part.Color = map.lavaColor
        elseif part.Name == "Wall" then
            part.Color = map.wallColor
        end
    end
end

--------------------------------------------------------------------------------
-- TILE GRID
--------------------------------------------------------------------------------

local function tileCenter(row, col, gridSize)
    gridSize = gridSize or 10
    local tileSize = MAP_SIZE / gridSize
    local x = (col - 1) * tileSize - MAP_SIZE / 2 + tileSize / 2
    local z = (row - 1) * tileSize - MAP_SIZE / 2 + tileSize / 2
    return Vector3.new(x, TILE_HEIGHT / 2, z)
end

local function tileColor(row, col, tileType)
    local tt = TILE_TYPES[tileType]
    if not tt then tt = TILE_TYPES.grass end
    if (row + col) % 2 == 0 then
        return tt.color1
    else
        return tt.color2
    end
end

local function getWarningDuration(tileType)
    local tt = TILE_TYPES[tileType]
    if not tt then return WARNING_DURATION end
    return tt.warningDuration
end

local function isTileWarning(key)
    for _, w in ipairs(warningTiles) do
        if w.key == key then return true end
    end
    return false
end

local function createTileGrid(map)
    tiles = {}
    warningTiles = {}
    tilesRemaining = 0
    safeTileKey = nil
    safeTileTimer = 0
    safeTileSpawnTimer = SAFE_ZONE_INTERVAL / 2

    local grid = map.grid
    local heights = map.heights or {}
    local tileSize = MAP_SIZE / 10

    for row = 1, 10 do
        for col = 1, 10 do
            local tileType = grid[row] and grid[row][col]
            if tileType then
                local key = tileKey(row, col)
                local heightOffset = heights[key] or 0

                local tile = Instance.new("Part")
                tile.Name = "Tile_" .. row .. "_" .. col
                tile.Size = Vector3.new(tileSize - 0.4, TILE_HEIGHT, tileSize - 0.4)
                local center = tileCenter(row, col)
                tile.Position = Vector3.new(center.X, center.Y + heightOffset, center.Z)
                tile.Anchored = true
                tile.Color = tileColor(row, col, tileType)
                tile.Parent = Workspace

                tiles[key] = {
                    part = tile,
                    row = row,
                    col = col,
                    tileType = tileType,
                    heightOffset = heightOffset,
                }
                tilesRemaining = tilesRemaining + 1
            end
        end
    end
end

local function destroyTileGrid()
    for key, tileData in pairs(tiles) do
        if tileData.part then
            tileData.part:Destroy()
        end
    end
    tiles = {}
    warningTiles = {}
    tilesRemaining = 0
    safeTileKey = nil
end

local function destroyRoundDecorations()
    for _, part in ipairs(roundDecorations) do
        if part then part:Destroy() end
    end
    roundDecorations = {}
end

--------------------------------------------------------------------------------
-- SAFE ZONE
--------------------------------------------------------------------------------

local function clearSafeZone()
    if safeTileKey and tiles[safeTileKey] then
        local td = tiles[safeTileKey]
        td.part.Color = tileColor(td.row, td.col, td.tileType)
    end
    safeTileKey = nil
    safeTileTimer = 0
end

local function spawnSafeZone()
    clearSafeZone()

    local candidates = {}
    for key, td in pairs(tiles) do
        if key and not isTileWarning(key) and key ~= safeTileKey then
            table.insert(candidates, key)
        end
    end

    if #candidates == 0 then return end

    local pick = candidates[math.random(#candidates)]
    if not pick then return end

    safeTileKey = pick
    safeTileTimer = SAFE_ZONE_DURATION

    local td = tiles[pick]
    if td and td.part then
        td.part.Color = Color3.fromRGB(50, 180, 255)
    end

    print("Safe zone appeared at tile " .. tostring(pick))
end

local function updateSafeZone(dt)
    if not roundActive then return end

    safeTileSpawnTimer = safeTileSpawnTimer - dt
    if safeTileSpawnTimer <= 0 and not safeTileKey then
        safeTileSpawnTimer = SAFE_ZONE_INTERVAL
        spawnSafeZone()
    end

    if safeTileKey then
        safeTileTimer = safeTileTimer - dt
        if safeTileTimer <= 0 then
            clearSafeZone()
        end
    end
end

--------------------------------------------------------------------------------
-- TILE WARNING & FALLING
--------------------------------------------------------------------------------

local function pickRandomTile()
    local available = {}
    for key, td in pairs(tiles) do
        if not isTileWarning(key) and key ~= safeTileKey then
            table.insert(available, key)
        end
    end
    if #available == 0 then return nil end
    return available[math.random(#available)]
end

local function warnTile(key)
    local td = tiles[key]
    if not td or not td.part then return end
    if isTileWarning(key) then return end
    if key == safeTileKey then return end

    local duration = getWarningDuration(td.tileType)

    td.part.Color = Color3.fromRGB(240, 210, 40)
    table.insert(warningTiles, {
        key = key,
        tile = td.part,
        row = td.row,
        col = td.col,
        timer = duration,
        totalDuration = duration,
        phase = "yellow",
    })
end

local function warnCluster(key)
    warnTile(key)

    local td = tiles[key]
    if not td then return end

    if math.random() < CLUSTER_CHANCE then
        local dirs = {{-1,0},{1,0},{0,-1},{0,1}}
        for i = #dirs, 2, -1 do
            local j = math.random(i)
            dirs[i], dirs[j] = dirs[j], dirs[i]
        end
        local count = math.random(1, 2)
        local warned = 0
        for _, d in ipairs(dirs) do
            if warned >= count then break end
            local nk = tileKey(td.row + d[1], td.col + d[2])
            if tiles[nk] and not isTileWarning(nk) and nk ~= safeTileKey then
                warnTile(nk)
                warned = warned + 1
            end
        end
    end
end

local function destroyTileEntry(entry)
    local tile = entry.tile
    if tile then
        tile.Anchored = false
        task.delay(2, function()
            if tile then tile:Destroy() end
        end)
    end
    tiles[entry.key] = nil
    tilesRemaining = tilesRemaining - 1
end

local function updateWarningTiles(dt)
    local i = 1
    while i <= #warningTiles do
        local entry = warningTiles[i]
        entry.timer = entry.timer - dt

        if entry.phase == "yellow" and entry.timer <= entry.totalDuration * 0.4 then
            entry.phase = "red"
            if entry.tile then
                entry.tile.Color = Color3.fromRGB(220, 40, 20)
            end
        end

        if entry.timer <= 0 then
            destroyTileEntry(entry)
            table.remove(warningTiles, i)
        else
            i = i + 1
        end
    end
end

local function shrinkRing()
    currentRing = currentRing + 1
    local ring = currentRing - 1
    local warned = 0

    for key, td in pairs(tiles) do
        if tileRing(td.row, td.col) == ring then
            if not isTileWarning(key) and key ~= safeTileKey then
                warnTile(key)
                warned = warned + 1
            end
        end
    end

    if warned > 0 then
        local map = getMap()
        print("Ring " .. currentRing .. " collapsing! (" .. warned .. " tiles)")
    end
end

--------------------------------------------------------------------------------
-- PLAYER MANAGEMENT
--------------------------------------------------------------------------------

local function spawnPlayer(player)
    local hrp = getHRP(player)
    if not hrp then return end

    -- Pick a random existing tile to spawn on
    local tileList = {}
    for key, td in pairs(tiles) do
        table.insert(tileList, td)
    end

    if #tileList > 0 then
        local pick = tileList[math.random(#tileList)]
        local pos = pick.part.Position
        hrp.Position = Vector3.new(pos.X, pos.Y + TILE_HEIGHT + 2, pos.Z)
    else
        hrp.Position = Vector3.new(0, TILE_HEIGHT + 4, 0)
    end
end

local function getPlayerData(player)
    return playerData[player.Name]
end

local function setupPlayer(player)
    if not playerData[player.Name] then
        playerData[player.Name] = {
            name = player.Name,
            alive = true,
            wins = 0,
            userId = player.UserId,
        }
    else
        playerData[player.Name].alive = true
        playerData[player.Name].userId = player.UserId
    end
    spawnPlayer(player)
    print(player.Name .. " joined!")
end

local function cleanupPlayer(player)
    if playerData[player.Name] then
        playerData[player.Name].alive = false
    end
end

local function eliminatePlayer(player)
    local data = getPlayerData(player)
    if not data or not data.alive then return end

    data.alive = false
    print(player.Name .. " fell into the lava!")

    local hrp = getHRP(player)
    if hrp then
        hrp.Position = Vector3.new(0, 55, 0)
    end
end

local function checkFallenPlayers()
    for _, player in ipairs(Players:GetPlayers()) do
        local data = getPlayerData(player)
        if data and data.alive then
            local hrp = getHRP(player)
            if hrp and hrp.Position.Y < FALL_THRESHOLD then
                eliminatePlayer(player)
            end
        end
    end
end

--------------------------------------------------------------------------------
-- SCOREBOARD
--------------------------------------------------------------------------------

local function printScoreboard()
    local scores = {}
    for name, data in pairs(playerData) do
        table.insert(scores, {name = name, wins = data.wins})
    end
    table.sort(scores, function(a, b) return a.wins > b.wins end)

    print("=== SCOREBOARD ===")
    for i, s in ipairs(scores) do
        print("  " .. i .. ". " .. s.name .. " - " .. s.wins .. " wins")
    end
    print("==================")
end

--------------------------------------------------------------------------------
-- ROUND SYSTEM
--------------------------------------------------------------------------------

local function startRound()
    roundNumber = roundNumber + 1

    -- Cycle through maps
    currentMapIndex = ((roundNumber - 1) % #MAPS) + 1
    local map = getMap()

    print("")
    print("==========================================")
    print("  ROUND " .. roundNumber .. " - " .. map.name)
    print("==========================================")

    -- Clean up previous round
    destroyTileGrid()
    destroyRoundDecorations()

    -- Build new map
    createTileGrid(map)
    updateSceneryColors(map)

    -- Spawn decorations
    if map.decorations then
        roundDecorations = map.decorations()
    end

    -- Difficulty: each cycle through all 4 maps gets harder
    local cycle = math.floor((roundNumber - 1) / #MAPS)
    local difficultyBonus = math.min(cycle * 0.15, 0.6)
    tickInterval = (map.tickStart or INITIAL_TICK_INTERVAL) - difficultyBonus
    tickTimer = 0
    roundEndTimer = nil
    roundTimer = 0
    shrinkIndex = 1
    currentRing = 0

    for _, player in ipairs(Players:GetPlayers()) do
        if playerData[player.Name] then
            playerData[player.Name].alive = true
        else
            playerData[player.Name] = {name = player.Name, alive = true, wins = 0, userId = player.UserId}
        end
        spawnPlayer(player)
    end

    roundActive = true
    print("Stay on the tiles!")
    print("")
end

local function endRound(winner)
    roundActive = false

    print("")
    if winner then
        local data = playerData[winner.Name]
        if data then
            data.wins = data.wins + 1
        end
        print(winner.Name .. " wins round " .. roundNumber .. "!")
    else
        print("No one survived round " .. roundNumber .. "!")
    end

    printScoreboard()

    roundEndTimer = ROUND_RESTART_DELAY
    print("Next round in " .. ROUND_RESTART_DELAY .. " seconds...")
end

local function checkRoundEnd()
    local alive = getAlivePlayers()
    local totalPlayers = #Players:GetPlayers()

    if totalPlayers == 0 then return end

    -- Solo mode: survive until all tiles are gone
    if totalPlayers == 1 then
        if #alive == 0 then
            endRound(nil)
        end
        return
    end

    if #alive <= 1 then
        endRound(alive[1])
    end
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

if AgentInputService then
    AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
        if inputType == "MoveTo" and inputData and inputData.position then
            local humanoid = getHumanoid(player)
            if humanoid then
                local pos = inputData.position
                humanoid:MoveTo(Vector3.new(pos[1], pos[2], pos[3]))
            end
        end
    end)
end

--------------------------------------------------------------------------------
-- GAME LOOP
--------------------------------------------------------------------------------

Players.PlayerAdded:Connect(setupPlayer)
Players.PlayerRemoving:Connect(cleanupPlayer)

for _, player in ipairs(Players:GetPlayers()) do
    setupPlayer(player)
end

createScenery()
startRound()

RunService.Heartbeat:Connect(function(dt)
    if roundActive then
        local map = getMap()
        roundTimer = roundTimer + dt

        -- Random tile warnings
        tickTimer = tickTimer + dt
        if tickTimer >= tickInterval then
            tickTimer = 0

            local chosen = pickRandomTile()
            if chosen then
                warnCluster(chosen)
            end

            tickInterval = math.max(MIN_TICK_INTERVAL, tickInterval - RAMP_RATE)
        end

        -- Shrinking ring
        local mapShrinkTimes = map.shrinkTimes or SHRINK_TIMES
        if shrinkIndex <= #mapShrinkTimes and roundTimer >= mapShrinkTimes[shrinkIndex] then
            shrinkRing()
            shrinkIndex = shrinkIndex + 1
        end

        updateWarningTiles(dt)
        updateSafeZone(dt)
        checkFallenPlayers()
        checkRoundEnd()

        if tilesRemaining <= 0 and roundActive then
            endRound(nil)
        end
    else
        if roundEndTimer then
            roundEndTimer = roundEndTimer - dt
            if roundEndTimer <= 0 then
                roundEndTimer = nil
                startRound()
            end
        end
    end
end)

print("Floor is Lava - Game initialized!")
