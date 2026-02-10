-- 3D Maze Game
-- Navigate a procedurally generated maze, collect orbs, reach the goal.

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local AgentInputService = game:GetService("AgentInputService")

--------------------------------------------------------------------------------
-- CONFIGURATION
--------------------------------------------------------------------------------

local MAZE_COLS = 10
local MAZE_ROWS = 10
local CELL_SIZE = 10
local WALL_HEIGHT = 8
local WALL_THICK = 1
local COLLECTIBLE_COUNT = 12

local MAZE_W = MAZE_COLS * CELL_SIZE
local MAZE_D = MAZE_ROWS * CELL_SIZE
local OX = -MAZE_W / 2
local OZ = -MAZE_D / 2

local GOAL_ROW = MAZE_ROWS
local GOAL_COL = MAZE_COLS

--------------------------------------------------------------------------------
-- MAZE GENERATION  (recursive back-tracker / DFS)
--------------------------------------------------------------------------------

local grid = {}
local vis = {}

for r = 1, MAZE_ROWS do
    grid[r] = {}
    vis[r] = {}
    for c = 1, MAZE_COLS do
        grid[r][c] = { n = true, s = true, e = true, w = true }
        vis[r][c] = false
    end
end

-- Iterative DFS maze carver (avoids stack overflow)
do
    local dfsStack = {}
    vis[1][1] = true
    dfsStack[1] = { 1, 1 }
    local sp = 1

    while sp > 0 do
        local r = dfsStack[sp][1]
        local c = dfsStack[sp][2]

        -- Gather unvisited neighbours
        local nbrs = {}
        local nn = 0
        -- north
        if r > 1 and not vis[r - 1][c] then nn = nn + 1; nbrs[nn] = { r - 1, c, "n", "s" } end
        -- south
        if r < MAZE_ROWS and not vis[r + 1][c] then nn = nn + 1; nbrs[nn] = { r + 1, c, "s", "n" } end
        -- east
        if c < MAZE_COLS and not vis[r][c + 1] then nn = nn + 1; nbrs[nn] = { r, c + 1, "e", "w" } end
        -- west
        if c > 1 and not vis[r][c - 1] then nn = nn + 1; nbrs[nn] = { r, c - 1, "w", "e" } end

        if nn == 0 then
            sp = sp - 1                       -- backtrack
        else
            local pick = math.random(1, nn)
            local nb = nbrs[pick]
            local nr, nc2 = nb[1], nb[2]
            grid[r][c][nb[3]] = false
            grid[nr][nc2][nb[4]] = false
            vis[nr][nc2] = true
            sp = sp + 1
            dfsStack[sp] = { nr, nc2 }
        end
    end
end

--------------------------------------------------------------------------------
-- HELPERS
--------------------------------------------------------------------------------

local function cellCenter(r, c)
    return OX + (c - 0.5) * CELL_SIZE, OZ + (r - 0.5) * CELL_SIZE
end

local function openings(r, c)
    local cell = grid[r][c]
    local n = 0
    if not cell.n then n = n + 1 end
    if not cell.s then n = n + 1 end
    if not cell.e then n = n + 1 end
    if not cell.w then n = n + 1 end
    return n
end

local function getHumanoid(player)
    local ch = player.Character
    if ch then return ch:FindFirstChild("Humanoid") end
    return nil
end

local function getPos(player)
    local ch = player.Character
    if ch then
        local hrp = ch:FindFirstChild("HumanoidRootPart")
        if hrp then return hrp.Position end
    end
    return nil
end

--------------------------------------------------------------------------------
-- MAP CREATION
--------------------------------------------------------------------------------

local wallFolder = Instance.new("Folder")
wallFolder.Name = "Walls"
wallFolder:AddTag("Static")
wallFolder.Parent = Workspace

-- Color palette for walls (dark blue-gray variations, 0-1 range)
local wallColors = {
    Color3.new(0.165, 0.227, 0.376),
    Color3.new(0.188, 0.251, 0.400),
    Color3.new(0.149, 0.204, 0.353),
    Color3.new(0.204, 0.267, 0.424),
}

local wallIdx = 0
local function makeWall(x, z, sx, sz)
    wallIdx = wallIdx + 1
    local w = Instance.new("Part")
    w.Name = "Wall_" .. wallIdx
    w.Size = Vector3.new(sx, WALL_HEIGHT, sz)
    w.Position = Vector3.new(x, WALL_HEIGHT / 2, z)
    w.Anchored = true
    w.Color = wallColors[math.random(1, 4)]
    w.Material = Enum.Material.Concrete
    w:AddTag("Static")
    w.Parent = wallFolder
end

-- Floor
local floor = Instance.new("Part")
floor.Name = "Floor"
floor.Size = Vector3.new(MAZE_W + 6, 1, MAZE_D + 6)
floor.Position = Vector3.new(0, -0.5, 0)
floor.Anchored = true
floor.Color = Color3.new(0.627, 0.549, 0.431)
floor.Material = Enum.Material.Concrete
floor:AddTag("Static")
floor.Parent = Workspace

-- Horizontal walls (north edge of each cell)
for r = 1, MAZE_ROWS do
    for c = 1, MAZE_COLS do
        if grid[r][c].n then
            makeWall(
                OX + (c - 0.5) * CELL_SIZE,
                OZ + (r - 1) * CELL_SIZE,
                CELL_SIZE + WALL_THICK,
                WALL_THICK
            )
        end
    end
end
-- South border
for c = 1, MAZE_COLS do
    if grid[MAZE_ROWS][c].s then
        makeWall(
            OX + (c - 0.5) * CELL_SIZE,
            OZ + MAZE_ROWS * CELL_SIZE,
            CELL_SIZE + WALL_THICK,
            WALL_THICK
        )
    end
end

-- Vertical walls (west edge of each cell)
for r = 1, MAZE_ROWS do
    for c = 1, MAZE_COLS do
        if grid[r][c].w then
            makeWall(
                OX + (c - 1) * CELL_SIZE,
                OZ + (r - 0.5) * CELL_SIZE,
                WALL_THICK,
                CELL_SIZE + WALL_THICK
            )
        end
    end
end
-- East border
for r = 1, MAZE_ROWS do
    if grid[r][MAZE_COLS].e then
        makeWall(
            OX + MAZE_COLS * CELL_SIZE,
            OZ + (r - 0.5) * CELL_SIZE,
            WALL_THICK,
            CELL_SIZE + WALL_THICK
        )
    end
end

print("Walls placed: " .. wallIdx)

--------------------------------------------------------------------------------
-- DECORATIVE ELEMENTS
--------------------------------------------------------------------------------

-- Start pad
local startX, startZ = cellCenter(1, 1)
local startPad = Instance.new("Part")
startPad.Name = "StartPad"
startPad.Shape = Enum.PartType.Cylinder
startPad.Size = Vector3.new(0.3, CELL_SIZE * 0.5, CELL_SIZE * 0.5)
startPad.CFrame = CFrame.new(startX, 0.15, startZ) * CFrame.Angles(0, 0, math.rad(90))
startPad.Anchored = true
startPad.Color = Color3.new(0.314, 0.784, 0.471)
startPad.Material = Enum.Material.Neon
startPad.Transparency = 0.4
startPad.CanCollide = false
startPad:AddTag("Static")
startPad.Parent = Workspace

-- Goal pad + beam
local goalX, goalZ = cellCenter(GOAL_ROW, GOAL_COL)

local goalPad = Instance.new("Part")
goalPad.Name = "Goal"
goalPad.Shape = Enum.PartType.Cylinder
goalPad.Size = Vector3.new(0.4, CELL_SIZE * 0.55, CELL_SIZE * 0.55)
goalPad.CFrame = CFrame.new(goalX, 0.2, goalZ) * CFrame.Angles(0, 0, math.rad(90))
goalPad.Anchored = true
goalPad.Color = Color3.new(0, 0.941, 0.706)
goalPad.Material = Enum.Material.Neon
goalPad.Transparency = 0.3
goalPad.CanCollide = false
goalPad.Parent = Workspace

local goalBeam = Instance.new("Part")
goalBeam.Name = "GoalBeam"
goalBeam.Size = Vector3.new(0.8, 40, 0.8)
goalBeam.Position = Vector3.new(goalX, 20, goalZ)
goalBeam.Anchored = true
goalBeam.Color = Color3.new(0, 0.941, 0.706)
goalBeam.Material = Enum.Material.Neon
goalBeam.Transparency = 0.75
goalBeam.CanCollide = false
goalBeam.Parent = Workspace

-- Torches at dead ends (1 opening)
for r = 1, MAZE_ROWS do
    for c = 1, MAZE_COLS do
        if openings(r, c) == 1 then
            local cx, cz = cellCenter(r, c)
            local cell = grid[r][c]
            local tx, tz = cx, cz
            -- Place torch against the wall opposite the single opening
            if not cell.n then tz = cz + CELL_SIZE * 0.35
            elseif not cell.s then tz = cz - CELL_SIZE * 0.35
            elseif not cell.e then tx = cx - CELL_SIZE * 0.35
            elseif not cell.w then tx = cx + CELL_SIZE * 0.35
            end
            local torch = Instance.new("Part")
            torch.Name = "Torch"
            torch.Size = Vector3.new(0.5, 1.2, 0.5)
            torch.Position = Vector3.new(tx, 3.5, tz)
            torch.Anchored = true
            torch.Color = Color3.new(1, 0.627, 0.235)
            torch.Material = Enum.Material.Neon
            torch.CanCollide = false
            torch:AddTag("Static")
            torch.Parent = wallFolder
        end
    end
end

-- Junction markers (floor lights at 3+ openings)
for r = 1, MAZE_ROWS do
    for c = 1, MAZE_COLS do
        if openings(r, c) >= 3 then
            local cx, cz = cellCenter(r, c)
            local mk = Instance.new("Part")
            mk.Name = "Junction"
            mk.Shape = Enum.PartType.Cylinder
            mk.Size = Vector3.new(0.15, 1.8, 1.8)
            mk.CFrame = CFrame.new(cx, 0.08, cz) * CFrame.Angles(0, 0, math.rad(90))
            mk.Anchored = true
            mk.Color = Color3.new(0.353, 0.510, 0.784)
            mk.Material = Enum.Material.Neon
            mk.Transparency = 0.4
            mk.CanCollide = false
            mk:AddTag("Static")
            mk.Parent = wallFolder
        end
    end
end

--------------------------------------------------------------------------------
-- COLLECTIBLE ORBS
--------------------------------------------------------------------------------

local collectibles = {}
local usedCells = {}
usedCells["1_1"] = true
usedCells[GOAL_ROW .. "_" .. GOAL_COL] = true

for i = 1, COLLECTIBLE_COUNT do
    local r, c
    repeat
        r = math.random(MAZE_ROWS)
        c = math.random(MAZE_COLS)
    until not usedCells[r .. "_" .. c]
    usedCells[r .. "_" .. c] = true

    local cx, cz = cellCenter(r, c)
    local orb = Instance.new("Part")
    orb.Name = "Orb_" .. i
    orb.Shape = Enum.PartType.Ball
    orb.Size = Vector3.new(1.6, 1.6, 1.6)
    orb.Position = Vector3.new(cx, 2.5, cz)
    orb.Anchored = true
    orb.Color = Color3.new(1, 0.824, 0.235)
    orb.Material = Enum.Material.Neon
    orb.CanCollide = false
    orb:SetAttribute("OrbIndex", i)
    orb.Parent = Workspace
    collectibles[i] = { part = orb, collected = false, row = r, col = c }
end

--------------------------------------------------------------------------------
-- GAME STATE
--------------------------------------------------------------------------------

local gameState = Instance.new("Folder")
gameState.Name = "GameState"
gameState:SetAttribute("Phase", "active")
gameState:SetAttribute("ElapsedTime", 0)
gameState:SetAttribute("TotalOrbs", COLLECTIBLE_COUNT)
gameState.Parent = Workspace

--------------------------------------------------------------------------------
-- PLAYER MANAGEMENT
--------------------------------------------------------------------------------

local playerData = {}

local function setupPlayer(player)
    playerData[player.UserId] = {
        name = player.Name,
        score = 0,
        orbs = 0,
        startTime = tick(),
        finished = false,
    }

    player:SetAttribute("Score", 0)
    player:SetAttribute("OrbsCollected", 0)
    player:SetAttribute("Finished", false)
    player:SetAttribute("MazeRows", MAZE_ROWS)
    player:SetAttribute("MazeCols", MAZE_COLS)
    player:SetAttribute("CellSize", CELL_SIZE)
    player:SetAttribute("GoalRow", GOAL_ROW)
    player:SetAttribute("GoalCol", GOAL_COL)

    local ch = player.Character
    if ch then
        local hrp = ch:FindFirstChild("HumanoidRootPart")
        if hrp then
            hrp.Position = Vector3.new(startX, 3, startZ)
        end
        local hum = ch:FindFirstChild("Humanoid")
        if hum then
            hum.WalkSpeed = 22
        end
    end

    print("Player entered maze: " .. player.Name)
end

local function cleanupPlayer(player)
    playerData[player.UserId] = nil
end

Players.PlayerAdded:Connect(setupPlayer)
Players.PlayerRemoving:Connect(cleanupPlayer)
for _, p in ipairs(Players:GetPlayers()) do
    setupPlayer(p)
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

if AgentInputService then
    AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
        if inputType == "MoveTo" and inputData and inputData.position then
            local hum = getHumanoid(player)
            if hum then
                local pos = inputData.position
                hum:MoveTo(Vector3.new(pos[1], pos[2], pos[3]))
            end
        end
    end)
end

--------------------------------------------------------------------------------
-- GAME LOOP
--------------------------------------------------------------------------------

local elapsed = 0
local PICKUP_RADIUS = CELL_SIZE * 0.4
local GOAL_RADIUS = CELL_SIZE * 0.45

RunService.Heartbeat:Connect(function(dt)
    elapsed = elapsed + dt
    gameState:SetAttribute("ElapsedTime", math.floor(elapsed))

    -- Animate goal pad pulse
    goalPad.Transparency = 0.2 + 0.15 * math.sin(elapsed * 3)

    -- Animate orbs (bob + spin via color shift)
    for i, col in ipairs(collectibles) do
        if not col.collected then
            local cx, cz = cellCenter(col.row, col.col)
            local bob = 2.5 + 0.6 * math.sin(elapsed * 2.2 + i * 1.3)
            col.part.Position = Vector3.new(cx, bob, cz)
        end
    end

    -- Per-player logic
    for _, player in ipairs(Players:GetPlayers()) do
        local data = playerData[player.UserId]
        if data and not data.finished then
            local pos = getPos(player)
            if pos then
                -- Collect orbs
                for i, col in ipairs(collectibles) do
                    if not col.collected then
                        local cx, cz = cellCenter(col.row, col.col)
                        local dist = (pos - Vector3.new(cx, pos.Y, cz)).Magnitude
                        if dist < PICKUP_RADIUS then
                            col.collected = true
                            col.part:Destroy()
                            data.orbs = data.orbs + 1
                            data.score = data.score + 100
                            player:SetAttribute("Score", data.score)
                            player:SetAttribute("OrbsCollected", data.orbs)
                            print(player.Name .. " orb " .. data.orbs .. "/" .. COLLECTIBLE_COUNT)
                        end
                    end
                end

                -- Check goal
                local gd = (pos - Vector3.new(goalX, pos.Y, goalZ)).Magnitude
                if gd < GOAL_RADIUS then
                    data.finished = true
                    local t = tick() - data.startTime
                    local timeBonus = math.max(0, math.floor(1000 - t * 5))
                    data.score = data.score + 500 + timeBonus
                    player:SetAttribute("Score", data.score)
                    player:SetAttribute("Finished", true)
                    player:SetAttribute("CompletionTime", math.floor(t))
                    print(player.Name .. " finished! " .. math.floor(t) .. "s  score=" .. data.score)
                end
            end
        end
    end
end)

print("Maze game initialized  (" .. MAZE_COLS .. "x" .. MAZE_ROWS .. ", " .. wallIdx .. " walls, " .. COLLECTIBLE_COUNT .. " orbs)")
