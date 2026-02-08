-- Crystal Climb: Sky Realms
-- A vertical obstacle course adventure through 4 themed sky islands.
-- Collect crystals, survive hazards, reach the summit!

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local AgentInputService = game:GetService("AgentInputService")

--------------------------------------------------------------------------------
-- CONFIGURATION
--------------------------------------------------------------------------------

local MAP_SIZE = 120
local ZONE_HEIGHT = 40
local CRYSTAL_COLLECT_RADIUS = 5
local CHECKPOINT_RADIUS = 6
local KILL_BRICK_DAMAGE = 999
local JUMP_PAD_FORCE = 80
local RESPAWN_DELAY = 2
local DISAPPEARING_PLATFORM_INTERVAL = 3
local MOVING_PLATFORM_SPEED = 8
local MOVING_PLATFORM_RANGE = 15

-- Zone Y offsets
local ZONE_Y = {
    forest = 0,
    lava = 45,
    ice = 95,
    sky = 145,
}

-- Zone colors
local ZONE_COLORS = {
    forest = {
        platform = Color3.fromRGB(90, 140, 70),
        accent = Color3.fromRGB(60, 100, 50),
        floor = Color3.fromRGB(80, 130, 60),
    },
    lava = {
        platform = Color3.fromRGB(80, 40, 30),
        accent = Color3.fromRGB(200, 60, 20),
        floor = Color3.fromRGB(180, 50, 10),
    },
    ice = {
        platform = Color3.fromRGB(180, 210, 240),
        accent = Color3.fromRGB(140, 180, 220),
        floor = Color3.fromRGB(200, 230, 255),
    },
    sky = {
        platform = Color3.fromRGB(200, 180, 140),
        accent = Color3.fromRGB(180, 150, 100),
        floor = Color3.fromRGB(220, 200, 160),
    },
}

--------------------------------------------------------------------------------
-- GAME STATE
--------------------------------------------------------------------------------

local playerData = {}
local crystals = {}
local checkpoints = {}
local killBricks = {}
local jumpPads = {}
local movingPlatforms = {}
local disappearingPlatforms = {}
local decorations = {}

--------------------------------------------------------------------------------
-- HELPER FUNCTIONS
--------------------------------------------------------------------------------

local function getHumanoid(player)
    local character = player.Character
    if character then
        return character:FindFirstChild("Humanoid")
    end
    return nil
end

local function getHRP(player)
    local character = player.Character
    if character then
        return character:FindFirstChild("HumanoidRootPart")
    end
    return nil
end

local function distXZ(a, b)
    local dx = a.X - b.X
    local dz = a.Z - b.Z
    return math.sqrt(dx * dx + dz * dz)
end

local function dist3D(a, b)
    return (a - b).Magnitude
end

local function randomInRange(min, max)
    return min + math.random() * (max - min)
end

--------------------------------------------------------------------------------
-- PART CREATION HELPERS
--------------------------------------------------------------------------------

local function createPart(name, size, position, color, material, anchored, parent)
    local part = Instance.new("Part")
    part.Name = name or "Part"
    part.Size = size or Vector3.new(4, 1, 4)
    part.Position = position or Vector3.new(0, 0, 0)
    part.Color = color or Color3.fromRGB(150, 150, 150)
    part.Material = material or Enum.Material.Plastic
    part.Anchored = anchored ~= false
    part.Parent = parent or Workspace
    return part
end

local function createPlatform(name, size, position, color, material)
    return createPart(name, size, position, color, material or Enum.Material.Concrete, true)
end

local function createDecoration(name, size, position, color, modelUrl)
    local part = createPart(name, size, position, color, Enum.Material.Plastic, true)
    if modelUrl then
        part:SetAttribute("ModelUrl", modelUrl)
    end
    table.insert(decorations, part)
    return part
end

--------------------------------------------------------------------------------
-- CRYSTAL CREATION
--------------------------------------------------------------------------------

local function createCrystal(position, value, hidden)
    local crystal = Instance.new("Part")
    crystal.Name = "Crystal"
    crystal.Shape = Enum.PartType.Ball
    crystal.Size = Vector3.new(2, 2, 2)
    crystal.Position = position
    crystal.Anchored = true
    crystal.CanCollide = false
    crystal.Material = Enum.Material.Neon

    if hidden then
        crystal.Color = Color3.fromRGB(255, 200, 50) -- gold for hidden/bonus
        crystal:SetAttribute("Value", (value or 1) * 3)
        crystal:SetAttribute("Hidden", true)
    else
        crystal.Color = Color3.fromRGB(160, 80, 255) -- purple
        crystal:SetAttribute("Value", value or 1)
        crystal:SetAttribute("Hidden", false)
    end

    crystal:SetAttribute("ModelUrl", "asset://models/crystal.glb")
    crystal:SetAttribute("Collected", false)
    crystal.Parent = Workspace

    table.insert(crystals, crystal)
    return crystal
end

--------------------------------------------------------------------------------
-- CHECKPOINT CREATION
--------------------------------------------------------------------------------

local function createCheckpoint(position, zoneIndex, name)
    local cp = Instance.new("Part")
    cp.Name = name or ("Checkpoint_" .. zoneIndex)
    cp.Size = Vector3.new(6, 8, 2)
    cp.Position = position
    cp.Anchored = true
    cp.CanCollide = false
    cp.Transparency = 0.3
    cp.Color = Color3.fromRGB(50, 255, 50)
    cp.Material = Enum.Material.Neon
    cp:SetAttribute("ModelUrl", "asset://models/archway.glb")
    cp:SetAttribute("ZoneIndex", zoneIndex)
    cp:SetAttribute("SpawnX", position.X)
    cp:SetAttribute("SpawnY", position.Y + 3)
    cp:SetAttribute("SpawnZ", position.Z + 3)
    cp.Parent = Workspace

    table.insert(checkpoints, cp)
    return cp
end

--------------------------------------------------------------------------------
-- HAZARD CREATION
--------------------------------------------------------------------------------

local function createKillBrick(name, size, position, color)
    local kb = createPart(name or "KillBrick", size, position, color or Color3.fromRGB(255, 30, 30), Enum.Material.Neon, true)
    kb:SetAttribute("IsKillBrick", true)
    table.insert(killBricks, kb)
    return kb
end

local function createJumpPad(position, force)
    local pad = createPart("JumpPad", Vector3.new(5, 0.5, 5), position, Color3.fromRGB(255, 255, 0), Enum.Material.Neon, true)
    pad:SetAttribute("IsJumpPad", true)
    pad:SetAttribute("Force", force or JUMP_PAD_FORCE)
    table.insert(jumpPads, pad)
    return pad
end

local function createMovingPlatform(name, size, position, color, axis, range, speed)
    local plat = createPlatform(name or "MovingPlatform", size, position, color)
    plat:SetAttribute("IsMoving", true)
    plat:SetAttribute("StartX", position.X)
    plat:SetAttribute("StartY", position.Y)
    plat:SetAttribute("StartZ", position.Z)
    plat:SetAttribute("Axis", axis or "x") -- "x", "y", or "z"
    plat:SetAttribute("Range", range or MOVING_PLATFORM_RANGE)
    plat:SetAttribute("Speed", speed or MOVING_PLATFORM_SPEED)
    table.insert(movingPlatforms, plat)
    return plat
end

local function createDisappearingPlatform(name, size, position, color, interval, offset)
    local plat = createPlatform(name or "DisappearingPlatform", size, position, color)
    plat:SetAttribute("IsDisappearing", true)
    plat:SetAttribute("Interval", interval or DISAPPEARING_PLATFORM_INTERVAL)
    plat:SetAttribute("TimeOffset", offset or 0)
    table.insert(disappearingPlatforms, plat)
    return plat
end

--------------------------------------------------------------------------------
-- ZONE 1: FOREST GROVE (Y: 0 - 40)
-- Gentle introduction. Wide platforms, easy jumps. Trees and mushrooms.
--------------------------------------------------------------------------------

local function createForestZone()
    local Y = ZONE_Y.forest
    local C = ZONE_COLORS.forest

    -- Starting island (large, safe)
    createPlatform("Forest_Start", Vector3.new(30, 3, 30), Vector3.new(0, Y - 1, 0), C.floor, Enum.Material.Grass)

    -- Spawn checkpoint
    createCheckpoint(Vector3.new(0, Y + 2, -10), 1, "Spawn")

    -- Decorative trees on start island
    createDecoration("Tree1", Vector3.new(3, 8, 3), Vector3.new(-8, Y + 5, -8), C.accent, "asset://models/tree.glb")
    createDecoration("Tree2", Vector3.new(3, 8, 3), Vector3.new(8, Y + 5, 8), C.accent, "asset://models/tree.glb")
    createDecoration("Tree3", Vector3.new(2, 6, 2), Vector3.new(-10, Y + 4, 5), C.accent, "asset://models/tree.glb")

    -- Mushroom decorations
    createDecoration("Mushroom1", Vector3.new(2, 3, 2), Vector3.new(5, Y + 2, -5), Color3.fromRGB(200, 50, 50), "asset://models/mushroom.glb")
    createDecoration("Mushroom2", Vector3.new(1.5, 2, 1.5), Vector3.new(-5, Y + 1.5, 7), Color3.fromRGB(200, 50, 50), "asset://models/mushroom.glb")

    -- Stepping stone platforms leading forward
    local platforms = {
        {Vector3.new(8, 1, 8), Vector3.new(0, Y + 2, 20)},
        {Vector3.new(7, 1, 7), Vector3.new(10, Y + 5, 30)},
        {Vector3.new(6, 1, 8), Vector3.new(-5, Y + 8, 40)},
        {Vector3.new(8, 1, 6), Vector3.new(8, Y + 11, 48)},
        {Vector3.new(6, 1, 6), Vector3.new(-8, Y + 14, 55)},
        {Vector3.new(7, 1, 7), Vector3.new(5, Y + 17, 62)},
    }

    for i, p in ipairs(platforms) do
        createPlatform("Forest_Plat" .. i, p[1], p[2], C.platform, Enum.Material.Grass)

        -- Add trees on some platforms
        if i % 2 == 0 then
            createDecoration("Tree_P" .. i, Vector3.new(2, 5, 2), Vector3.new(p[2].X - 2, p[2].Y + 3, p[2].Z), C.accent, "asset://models/tree.glb")
        end
    end

    -- Crystals scattered along the path
    createCrystal(Vector3.new(0, Y + 5, 20), 1)
    createCrystal(Vector3.new(10, Y + 8, 30), 1)
    createCrystal(Vector3.new(-5, Y + 11, 40), 1)
    createCrystal(Vector3.new(8, Y + 14, 48), 1)
    createCrystal(Vector3.new(5, Y + 20, 62), 2)

    -- Hidden bonus crystal (off to the side, requires exploration)
    createPlatform("Forest_Secret", Vector3.new(4, 1, 4), Vector3.new(-20, Y + 10, 35), C.accent, Enum.Material.Grass)
    createCrystal(Vector3.new(-20, Y + 13, 35), 2, true)

    -- Rock decorations
    createDecoration("Rock1", Vector3.new(3, 2, 3), Vector3.new(15, Y + 1, 10), Color3.fromRGB(120, 120, 110), "asset://models/rock.glb")
    createDecoration("Rock2", Vector3.new(2, 1.5, 2), Vector3.new(-12, Y + 1, 15), Color3.fromRGB(120, 120, 110), "asset://models/rock.glb")

    -- Jump pad to next zone
    createJumpPad(Vector3.new(5, Y + 18, 68), 90)

    -- Transition platform
    createPlatform("Forest_Top", Vector3.new(12, 2, 12), Vector3.new(0, Y + 30, 75), C.platform, Enum.Material.Grass)
    createCrystal(Vector3.new(0, Y + 34, 75), 2)

    -- Checkpoint to Lava zone
    createCheckpoint(Vector3.new(0, Y + 33, 80), 2, "Forest_End")

    print("Forest Grove created")
end

--------------------------------------------------------------------------------
-- ZONE 2: LAVA CAVERNS (Y: 45 - 90)
-- Dangerous! Lava floor kills, narrow paths, moving platforms.
--------------------------------------------------------------------------------

local function createLavaZone()
    local Y = ZONE_Y.lava
    local C = ZONE_COLORS.lava

    -- Entry platform
    createPlatform("Lava_Entry", Vector3.new(12, 2, 12), Vector3.new(0, Y, 0), C.platform, Enum.Material.Concrete)

    -- Lava floor (kill bricks)
    for x = -30, 30, 15 do
        for z = -5, 70, 15 do
            createKillBrick("Lava_Floor", Vector3.new(15, 1, 15), Vector3.new(x, Y - 5, z), Color3.fromRGB(255, 80, 0))
        end
    end

    -- Torch decorations
    createDecoration("Torch1", Vector3.new(1, 3, 1), Vector3.new(-5, Y + 3, 0), Color3.fromRGB(255, 150, 50), "asset://models/torch.glb")
    createDecoration("Torch2", Vector3.new(1, 3, 1), Vector3.new(5, Y + 3, 0), Color3.fromRGB(255, 150, 50), "asset://models/torch.glb")

    -- Narrow bridge
    createPlatform("Lava_Bridge1", Vector3.new(3, 1, 12), Vector3.new(0, Y + 1, 12), C.platform, Enum.Material.Concrete)

    -- Moving platforms over lava
    createMovingPlatform("Lava_Moving1", Vector3.new(5, 1, 5), Vector3.new(-10, Y + 3, 25), C.accent, "x", 12, 6)
    createMovingPlatform("Lava_Moving2", Vector3.new(5, 1, 5), Vector3.new(10, Y + 6, 35), C.accent, "x", 12, 8)
    createMovingPlatform("Lava_Moving3", Vector3.new(4, 1, 4), Vector3.new(0, Y + 9, 45), C.accent, "z", 10, 7)

    -- Static platforms with kill bricks on edges
    createPlatform("Lava_Safe1", Vector3.new(8, 1, 8), Vector3.new(-10, Y + 4, 25), C.platform, Enum.Material.Concrete)
    createKillBrick("Lava_Edge1", Vector3.new(8, 0.5, 1), Vector3.new(-10, Y + 4.5, 21), Color3.fromRGB(255, 50, 0))

    createPlatform("Lava_Safe2", Vector3.new(8, 1, 8), Vector3.new(10, Y + 8, 35), C.platform, Enum.Material.Concrete)
    createDecoration("Torch3", Vector3.new(1, 3, 1), Vector3.new(14, Y + 11, 35), Color3.fromRGB(255, 150, 50), "asset://models/torch.glb")

    createPlatform("Lava_Safe3", Vector3.new(10, 1, 6), Vector3.new(0, Y + 12, 50), C.platform, Enum.Material.Concrete)

    -- Rising column platforms
    createPlatform("Lava_Col1", Vector3.new(4, 8, 4), Vector3.new(-8, Y + 8, 55), C.platform, Enum.Material.Concrete)
    createPlatform("Lava_Col2", Vector3.new(4, 12, 4), Vector3.new(0, Y + 12, 60), C.platform, Enum.Material.Concrete)
    createPlatform("Lava_Col3", Vector3.new(4, 16, 4), Vector3.new(8, Y + 16, 65), C.platform, Enum.Material.Concrete)

    -- Crystals
    createCrystal(Vector3.new(0, Y + 4, 12), 2)
    createCrystal(Vector3.new(-10, Y + 7, 25), 2)
    createCrystal(Vector3.new(10, Y + 11, 35), 2)
    createCrystal(Vector3.new(0, Y + 15, 50), 3)
    createCrystal(Vector3.new(8, Y + 26, 65), 3)

    -- Hidden crystal behind a column
    createCrystal(Vector3.new(-15, Y + 5, 60), 5, true)
    createPlatform("Lava_Secret", Vector3.new(4, 1, 4), Vector3.new(-15, Y + 4, 60), C.accent, Enum.Material.Concrete)

    -- Jump pad to ice zone
    createJumpPad(Vector3.new(8, Y + 25, 65), 100)

    -- Transition platform
    createPlatform("Lava_Top", Vector3.new(12, 2, 12), Vector3.new(0, Y + 38, 70), C.platform, Enum.Material.Concrete)

    -- Checkpoint
    createCheckpoint(Vector3.new(0, Y + 41, 75), 3, "Lava_End")

    print("Lava Caverns created")
end

--------------------------------------------------------------------------------
-- ZONE 3: FROZEN PEAKS (Y: 95 - 140)
-- Icy platforms, disappearing blocks, wider gaps. Tricky timing.
--------------------------------------------------------------------------------

local function createIceZone()
    local Y = ZONE_Y.ice
    local C = ZONE_COLORS.ice

    -- Entry platform
    createPlatform("Ice_Entry", Vector3.new(14, 2, 14), Vector3.new(0, Y, 0), C.floor, Enum.Material.Glass)

    -- Ice spike decorations
    createDecoration("IceSpike1", Vector3.new(2, 5, 2), Vector3.new(-5, Y + 3, -3), C.accent, "asset://models/ice_spike.glb")
    createDecoration("IceSpike2", Vector3.new(2, 5, 2), Vector3.new(5, Y + 3, 3), C.accent, "asset://models/ice_spike.glb")
    createDecoration("IceSpike3", Vector3.new(1.5, 4, 1.5), Vector3.new(-6, Y + 3, 5), C.accent, "asset://models/ice_spike.glb")

    -- Disappearing platform sequence (timing puzzle)
    local disappearPlatforms = {
        {Vector3.new(5, 1, 5), Vector3.new(-5, Y + 3, 12), 0},
        {Vector3.new(5, 1, 5), Vector3.new(5, Y + 5, 20), 1},
        {Vector3.new(5, 1, 5), Vector3.new(-5, Y + 7, 28), 2},
        {Vector3.new(5, 1, 5), Vector3.new(5, Y + 9, 36), 0},
    }

    for i, p in ipairs(disappearPlatforms) do
        createDisappearingPlatform("Ice_Disappear" .. i, p[1], p[2], C.platform, 3, p[3])
    end

    -- Safe rest platform
    createPlatform("Ice_Rest1", Vector3.new(8, 1, 8), Vector3.new(0, Y + 11, 42), C.floor, Enum.Material.Glass)
    createDecoration("IceSpike4", Vector3.new(1.5, 4, 1.5), Vector3.new(3, Y + 14, 42), C.accent, "asset://models/ice_spike.glb")

    -- Zigzag narrow ice bridges
    createPlatform("Ice_Bridge1", Vector3.new(2, 1, 10), Vector3.new(-6, Y + 14, 50), C.platform, Enum.Material.Glass)
    createPlatform("Ice_Bridge2", Vector3.new(10, 1, 2), Vector3.new(0, Y + 17, 56), C.platform, Enum.Material.Glass)
    createPlatform("Ice_Bridge3", Vector3.new(2, 1, 10), Vector3.new(6, Y + 20, 62), C.platform, Enum.Material.Glass)

    -- Moving platforms (vertical for added challenge)
    createMovingPlatform("Ice_Moving1", Vector3.new(5, 1, 5), Vector3.new(-8, Y + 23, 70), C.accent, "y", 8, 5)
    createMovingPlatform("Ice_Moving2", Vector3.new(4, 1, 4), Vector3.new(8, Y + 28, 78), C.accent, "y", 6, 6)

    -- Final climb
    createPlatform("Ice_Step1", Vector3.new(5, 1, 5), Vector3.new(0, Y + 32, 82), C.platform, Enum.Material.Glass)
    createPlatform("Ice_Step2", Vector3.new(5, 1, 5), Vector3.new(-8, Y + 35, 86), C.platform, Enum.Material.Glass)
    createPlatform("Ice_Step3", Vector3.new(5, 1, 5), Vector3.new(0, Y + 38, 90), C.platform, Enum.Material.Glass)

    -- Crystals
    createCrystal(Vector3.new(-5, Y + 6, 12), 3)
    createCrystal(Vector3.new(5, Y + 8, 20), 3)
    createCrystal(Vector3.new(0, Y + 14, 42), 3)
    createCrystal(Vector3.new(-6, Y + 17, 50), 3)
    createCrystal(Vector3.new(6, Y + 23, 62), 4)
    createCrystal(Vector3.new(0, Y + 35, 82), 4)

    -- Hidden crystal (requires jumping off the beaten path)
    createPlatform("Ice_Secret", Vector3.new(3, 1, 3), Vector3.new(18, Y + 25, 55), C.accent, Enum.Material.Glass)
    createCrystal(Vector3.new(18, Y + 28, 55), 5, true)

    -- Jump pad to sky castle
    createJumpPad(Vector3.new(0, Y + 39, 90), 110)

    -- Transition
    createPlatform("Ice_Top", Vector3.new(12, 2, 12), Vector3.new(0, Y + 48, 95), C.floor, Enum.Material.Glass)

    -- Checkpoint
    createCheckpoint(Vector3.new(0, Y + 51, 100), 4, "Ice_End")

    print("Frozen Peaks created")
end

--------------------------------------------------------------------------------
-- ZONE 4: SKY CASTLE (Y: 145 - 200)
-- The final challenge! Floating castle ruins, hardest jumps, big rewards.
--------------------------------------------------------------------------------

local function createSkyCastleZone()
    local Y = ZONE_Y.sky
    local C = ZONE_COLORS.sky

    -- Entry platform (castle courtyard)
    createPlatform("Sky_Entry", Vector3.new(16, 2, 16), Vector3.new(0, Y, 0), C.floor, Enum.Material.Concrete)

    -- Castle tower decorations
    createDecoration("Tower1", Vector3.new(4, 12, 4), Vector3.new(-6, Y + 7, -4), C.accent, "asset://models/castle_tower.glb")
    createDecoration("Tower2", Vector3.new(4, 12, 4), Vector3.new(6, Y + 7, -4), C.accent, "asset://models/castle_tower.glb")

    -- Floating stone platforms (increasingly smaller and farther apart)
    local skyPlatforms = {
        {Vector3.new(6, 1, 6), Vector3.new(8, Y + 4, 14)},
        {Vector3.new(5, 1, 5), Vector3.new(-8, Y + 8, 24)},
        {Vector3.new(4, 1, 6), Vector3.new(5, Y + 12, 32)},
        {Vector3.new(5, 1, 4), Vector3.new(-10, Y + 16, 40)},
        {Vector3.new(4, 1, 4), Vector3.new(0, Y + 20, 48)},
    }

    for i, p in ipairs(skyPlatforms) do
        createPlatform("Sky_Plat" .. i, p[1], p[2], C.platform, Enum.Material.Concrete)
    end

    -- Moving + disappearing combo section
    createMovingPlatform("Sky_Moving1", Vector3.new(4, 1, 4), Vector3.new(10, Y + 24, 55), C.accent, "x", 15, 10)
    createDisappearingPlatform("Sky_Disappear1", Vector3.new(4, 1, 4), Vector3.new(-5, Y + 27, 60), C.platform, 2.5, 0)
    createDisappearingPlatform("Sky_Disappear2", Vector3.new(4, 1, 4), Vector3.new(5, Y + 30, 66), C.platform, 2.5, 1.2)
    createMovingPlatform("Sky_Moving2", Vector3.new(4, 1, 4), Vector3.new(-8, Y + 33, 72), C.accent, "z", 10, 9)

    -- Narrow crumbling bridge to summit
    createPlatform("Sky_Bridge", Vector3.new(2.5, 1, 15), Vector3.new(0, Y + 36, 82), C.platform, Enum.Material.Concrete)

    -- Kill bricks lining the bridge
    createKillBrick("Sky_KillL", Vector3.new(1, 2, 15), Vector3.new(-3, Y + 36, 82), Color3.fromRGB(100, 0, 150))
    createKillBrick("Sky_KillR", Vector3.new(1, 2, 15), Vector3.new(3, Y + 36, 82), Color3.fromRGB(100, 0, 150))

    -- Summit platform
    createPlatform("Sky_Summit", Vector3.new(14, 2, 14), Vector3.new(0, Y + 40, 98), Color3.fromRGB(255, 215, 80), Enum.Material.Neon)

    -- Treasure chest at the summit
    createDecoration("TreasureChest", Vector3.new(3, 2, 2), Vector3.new(0, Y + 42, 98), Color3.fromRGB(200, 170, 50), "asset://models/chest.glb")

    -- Crown trophy floating above
    createDecoration("Crown", Vector3.new(2, 2, 2), Vector3.new(0, Y + 48, 98), Color3.fromRGB(255, 215, 0), "asset://models/crown.glb")

    -- Castle ruin decorations around summit
    createDecoration("Tower3", Vector3.new(3, 8, 3), Vector3.new(-8, Y + 45, 95), C.accent, "asset://models/castle_tower.glb")
    createDecoration("Tower4", Vector3.new(3, 8, 3), Vector3.new(8, Y + 45, 101), C.accent, "asset://models/castle_tower.glb")

    -- Rock decorations on floating islands
    createDecoration("SkyRock1", Vector3.new(2, 1.5, 2), Vector3.new(10, Y + 5, 14), Color3.fromRGB(160, 150, 130), "asset://models/rock.glb")
    createDecoration("SkyRock2", Vector3.new(2, 1.5, 2), Vector3.new(-12, Y + 17, 40), Color3.fromRGB(160, 150, 130), "asset://models/rock.glb")

    -- Crystals
    createCrystal(Vector3.new(8, Y + 7, 14), 4)
    createCrystal(Vector3.new(-8, Y + 11, 24), 4)
    createCrystal(Vector3.new(5, Y + 15, 32), 4)
    createCrystal(Vector3.new(0, Y + 23, 48), 5)
    createCrystal(Vector3.new(0, Y + 39, 82), 5)

    -- Summit bonus crystal
    createCrystal(Vector3.new(0, Y + 45, 98), 10)

    -- Hidden crystal (way off to the side on a tiny platform)
    createPlatform("Sky_Secret", Vector3.new(3, 1, 3), Vector3.new(-25, Y + 30, 50), C.accent, Enum.Material.Concrete)
    createCrystal(Vector3.new(-25, Y + 33, 50), 10, true)

    -- Summit checkpoint (final)
    createCheckpoint(Vector3.new(0, Y + 43, 103), 5, "Summit")

    print("Sky Castle created")
end

--------------------------------------------------------------------------------
-- SKYBOX / ATMOSPHERE
--------------------------------------------------------------------------------

local function createAtmosphere()
    -- Void kill zone (fall off the map)
    createKillBrick("VoidKill", Vector3.new(500, 2, 500), Vector3.new(0, -30, 50), Color3.fromRGB(0, 0, 0))

    -- Decorative clouds at various heights
    local cloudPositions = {
        Vector3.new(-40, 35, 30), Vector3.new(40, 55, 60),
        Vector3.new(-30, 80, 50), Vector3.new(50, 100, 40),
        Vector3.new(-50, 120, 70), Vector3.new(30, 140, 20),
        Vector3.new(0, 160, 80), Vector3.new(-45, 170, 50),
    }

    for i, pos in ipairs(cloudPositions) do
        local cloud = createPart("Cloud" .. i, Vector3.new(randomInRange(10, 20), randomInRange(2, 4), randomInRange(8, 15)), pos, Color3.fromRGB(255, 255, 255), Enum.Material.Plastic, true)
        cloud.Transparency = 0.5
        cloud.CanCollide = false
    end

    -- Side boundary walls (invisible)
    local wallSize = Vector3.new(2, 300, 200)
    local wall1 = createPart("WallL", wallSize, Vector3.new(-60, 100, 50), Color3.fromRGB(100, 150, 200), Enum.Material.Plastic, true)
    wall1.Transparency = 1
    local wall2 = createPart("WallR", wallSize, Vector3.new(60, 100, 50), Color3.fromRGB(100, 150, 200), Enum.Material.Plastic, true)
    wall2.Transparency = 1
    local wall3 = createPart("WallB", Vector3.new(200, 300, 2), Vector3.new(0, 100, -30), Color3.fromRGB(100, 150, 200), Enum.Material.Plastic, true)
    wall3.Transparency = 1
    local wall4 = createPart("WallF", Vector3.new(200, 300, 2), Vector3.new(0, 100, 220), Color3.fromRGB(100, 150, 200), Enum.Material.Plastic, true)
    wall4.Transparency = 1
end

--------------------------------------------------------------------------------
-- MAP CREATION
--------------------------------------------------------------------------------

local function createMap()
    createAtmosphere()
    createForestZone()
    createLavaZone()
    createIceZone()
    createSkyCastleZone()

    print("Crystal Climb: Sky Realms map created!")
    print("Total crystals: " .. #crystals)
    print("Total checkpoints: " .. #checkpoints)
end

--------------------------------------------------------------------------------
-- PLAYER MANAGEMENT
--------------------------------------------------------------------------------

local function getPlayerZone(player)
    local hrp = getHRP(player)
    if not hrp then return 1 end
    local y = hrp.Position.Y
    if y >= ZONE_Y.sky - 5 then return 4
    elseif y >= ZONE_Y.ice - 5 then return 3
    elseif y >= ZONE_Y.lava - 5 then return 2
    else return 1 end
end

local function setupPlayer(player)
    playerData[player.UserId] = {
        name = player.Name,
        score = 0,
        crystalsCollected = 0,
        totalCrystals = #crystals,
        checkpoint = 1,
        checkpointPos = Vector3.new(0, 5, -7),
        zone = 1,
        deaths = 0,
        startTime = tick(),
        reachedSummit = false,
        collectedCrystals = {},
    }

    -- Set player attributes for observation
    local character = player.Character
    if character then
        local humanoid = character:FindFirstChild("Humanoid")
        if humanoid then
            humanoid.WalkSpeed = 20
            humanoid.JumpPower = 55
        end
    end

    updatePlayerAttributes(player)

    -- Move to spawn
    local hrp = getHRP(player)
    if hrp then
        hrp.Position = Vector3.new(0, 5, -7)
    end

    print("Player joined: " .. player.Name)
end

function updatePlayerAttributes(player)
    local data = playerData[player.UserId]
    if not data then return end

    player:SetAttribute("Score", data.score)
    player:SetAttribute("Crystals", data.crystalsCollected)
    player:SetAttribute("TotalCrystals", #crystals)
    player:SetAttribute("Zone", data.zone)
    player:SetAttribute("Checkpoint", data.checkpoint)
    player:SetAttribute("Deaths", data.deaths)
    player:SetAttribute("ReachedSummit", data.reachedSummit)

    local elapsed = tick() - data.startTime
    player:SetAttribute("TimeElapsed", math.floor(elapsed))

    -- Zone name for display
    local zoneNames = {"Forest Grove", "Lava Caverns", "Frozen Peaks", "Sky Castle"}
    player:SetAttribute("ZoneName", zoneNames[data.zone] or "Unknown")
end

local function respawnPlayer(player)
    local data = playerData[player.UserId]
    if not data then return end

    data.deaths = data.deaths + 1

    task.delay(RESPAWN_DELAY, function()
        local character = player.Character
        if character then
            local humanoid = character:FindFirstChild("Humanoid")
            if humanoid then
                humanoid.Health = humanoid.MaxHealth
            end
            local hrp = character:FindFirstChild("HumanoidRootPart")
            if hrp then
                hrp.Position = data.checkpointPos
            end
        end
        updatePlayerAttributes(player)
    end)
end

local function cleanupPlayer(player)
    playerData[player.UserId] = nil
    print("Player left: " .. player.Name)
end

--------------------------------------------------------------------------------
-- CRYSTAL COLLECTION
--------------------------------------------------------------------------------

local function tryCollectCrystal(player, crystalIndex)
    local data = playerData[player.UserId]
    if not data then return false end

    local crystal = crystals[crystalIndex]
    if not crystal then return false end
    if crystal:GetAttribute("Collected") then return false end
    if data.collectedCrystals[crystalIndex] then return false end

    local hrp = getHRP(player)
    if not hrp then return false end

    local distance = dist3D(hrp.Position, crystal.Position)
    if distance > CRYSTAL_COLLECT_RADIUS then return false end

    -- Collect!
    data.collectedCrystals[crystalIndex] = true
    data.crystalsCollected = data.crystalsCollected + 1
    local value = crystal:GetAttribute("Value") or 1
    data.score = data.score + value * 100

    -- Visual feedback - make crystal disappear for this player
    -- (In a real multiplayer game each player has their own collection state)
    crystal:SetAttribute("Collected", true)
    crystal.Transparency = 0.8
    crystal.CanCollide = false

    local isHidden = crystal:GetAttribute("Hidden")
    if isHidden then
        print(player.Name .. " found a HIDDEN crystal! +" .. (value * 100) .. " points!")
    else
        print(player.Name .. " collected a crystal! +" .. (value * 100) .. " points!")
    end

    updatePlayerAttributes(player)
    return true
end

local function collectNearestCrystal(player)
    local hrp = getHRP(player)
    if not hrp then return false end

    local bestDist = CRYSTAL_COLLECT_RADIUS
    local bestIndex = nil

    for i, crystal in ipairs(crystals) do
        if not crystal:GetAttribute("Collected") then
            local data = playerData[player.UserId]
            if data and not data.collectedCrystals[i] then
                local d = dist3D(hrp.Position, crystal.Position)
                if d < bestDist then
                    bestDist = d
                    bestIndex = i
                end
            end
        end
    end

    if bestIndex then
        return tryCollectCrystal(player, bestIndex)
    end
    return false
end

--------------------------------------------------------------------------------
-- CHECKPOINT LOGIC
--------------------------------------------------------------------------------

local function checkCheckpoints(player)
    local data = playerData[player.UserId]
    if not data then return end

    local hrp = getHRP(player)
    if not hrp then return end

    for _, cp in ipairs(checkpoints) do
        local distance = dist3D(hrp.Position, cp.Position)
        if distance < CHECKPOINT_RADIUS then
            local zoneIndex = cp:GetAttribute("ZoneIndex")
            if zoneIndex > data.checkpoint then
                data.checkpoint = zoneIndex
                data.checkpointPos = Vector3.new(
                    cp:GetAttribute("SpawnX"),
                    cp:GetAttribute("SpawnY"),
                    cp:GetAttribute("SpawnZ")
                )

                -- Bonus score for reaching checkpoint
                data.score = data.score + zoneIndex * 200
                print(player.Name .. " reached checkpoint: " .. cp.Name .. " (+" .. (zoneIndex * 200) .. " pts)")

                if cp.Name == "Summit" then
                    data.reachedSummit = true
                    local elapsed = tick() - data.startTime
                    -- Time bonus: faster = more points
                    local timeBonus = math.max(0, 5000 - math.floor(elapsed) * 5)
                    data.score = data.score + timeBonus
                    print(player.Name .. " REACHED THE SUMMIT! Time bonus: " .. timeBonus)
                end

                updatePlayerAttributes(player)
            end
        end
    end
end

--------------------------------------------------------------------------------
-- HAZARD DETECTION
--------------------------------------------------------------------------------

local function checkHazards(player)
    local humanoid = getHumanoid(player)
    local hrp = getHRP(player)
    if not humanoid or not hrp or humanoid.Health <= 0 then return end

    -- Kill bricks
    for _, kb in ipairs(killBricks) do
        local kbPos = kb.Position
        local kbSize = kb.Size
        local pPos = hrp.Position

        -- AABB check
        local halfX = kbSize.X / 2 + 1
        local halfY = kbSize.Y / 2 + 2
        local halfZ = kbSize.Z / 2 + 1

        if math.abs(pPos.X - kbPos.X) < halfX and
           math.abs(pPos.Y - kbPos.Y) < halfY and
           math.abs(pPos.Z - kbPos.Z) < halfZ then
            humanoid:TakeDamage(KILL_BRICK_DAMAGE)
            respawnPlayer(player)
            return
        end
    end

    -- Fall below map
    if hrp.Position.Y < -20 then
        humanoid:TakeDamage(KILL_BRICK_DAMAGE)
        respawnPlayer(player)
    end
end

--------------------------------------------------------------------------------
-- JUMP PAD DETECTION
--------------------------------------------------------------------------------

local function checkJumpPads(player)
    local humanoid = getHumanoid(player)
    local hrp = getHRP(player)
    if not humanoid or not hrp then return end

    for _, pad in ipairs(jumpPads) do
        local distance = dist3D(hrp.Position, pad.Position)
        if distance < 4 and hrp.Position.Y > pad.Position.Y - 1 then
            local force = pad:GetAttribute("Force") or JUMP_PAD_FORCE
            hrp.Velocity = Vector3.new(hrp.Velocity.X, force, hrp.Velocity.Z)
        end
    end
end

--------------------------------------------------------------------------------
-- MOVING PLATFORMS UPDATE
--------------------------------------------------------------------------------

local function updateMovingPlatforms(dt)
    local t = tick()
    for _, plat in ipairs(movingPlatforms) do
        local startX = plat:GetAttribute("StartX")
        local startY = plat:GetAttribute("StartY")
        local startZ = plat:GetAttribute("StartZ")
        local axis = plat:GetAttribute("Axis")
        local range = plat:GetAttribute("Range")
        local speed = plat:GetAttribute("Speed")

        local offset = math.sin(t * speed * 0.1) * range

        if axis == "x" then
            plat.Position = Vector3.new(startX + offset, startY, startZ)
        elseif axis == "y" then
            plat.Position = Vector3.new(startX, startY + offset, startZ)
        elseif axis == "z" then
            plat.Position = Vector3.new(startX, startY, startZ + offset)
        end
    end
end

--------------------------------------------------------------------------------
-- DISAPPEARING PLATFORMS UPDATE
--------------------------------------------------------------------------------

local function updateDisappearingPlatforms(dt)
    local t = tick()
    for _, plat in ipairs(disappearingPlatforms) do
        local interval = plat:GetAttribute("Interval") or DISAPPEARING_PLATFORM_INTERVAL
        local offset = plat:GetAttribute("TimeOffset") or 0
        local phase = (t + offset) % (interval * 2)

        if phase < interval then
            plat.Transparency = 0
            plat.CanCollide = true
        else
            plat.Transparency = 0.9
            plat.CanCollide = false
        end
    end
end

--------------------------------------------------------------------------------
-- CRYSTAL ANIMATION (floating + rotating via position oscillation)
--------------------------------------------------------------------------------

local function updateCrystalAnimations(dt)
    local t = tick()
    for i, crystal in ipairs(crystals) do
        if not crystal:GetAttribute("Collected") then
            local baseY = crystal.Position.Y
            -- Gentle float: each crystal has a unique phase offset based on index
            local floatOffset = math.sin(t * 2 + i * 0.7) * 0.3
            crystal.Position = Vector3.new(crystal.Position.X, baseY + floatOffset * dt, crystal.Position.Z)
        end
    end
end

--------------------------------------------------------------------------------
-- LEADERBOARD
--------------------------------------------------------------------------------

local function getLeaderboard()
    local board = {}
    for userId, data in pairs(playerData) do
        table.insert(board, {
            name = data.name,
            score = data.score,
            crystals = data.crystalsCollected,
            zone = data.zone,
            reachedSummit = data.reachedSummit,
        })
    end

    -- Sort by score descending
    table.sort(board, function(a, b) return a.score > b.score end)
    return board
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

if AgentInputService then
    AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
        if inputType == "MoveTo" and inputData and inputData.position then
            local humanoid = getHumanoid(player)
            if humanoid and humanoid.Health > 0 then
                local pos = inputData.position
                humanoid:MoveTo(Vector3.new(pos[1], pos[2], pos[3]))
            end

        elseif inputType == "Jump" then
            local humanoid = getHumanoid(player)
            local hrp = getHRP(player)
            if humanoid and hrp and humanoid.Health > 0 then
                hrp.Velocity = Vector3.new(hrp.Velocity.X, humanoid.JumpPower, hrp.Velocity.Z)
            end

        elseif inputType == "Collect" then
            collectNearestCrystal(player)

        elseif inputType == "GetLeaderboard" then
            -- Agent can query leaderboard
            local board = getLeaderboard()
            print("Leaderboard: " .. #board .. " players")
            for i, entry in ipairs(board) do
                print(i .. ". " .. entry.name .. " - " .. entry.score .. " pts (" .. entry.crystals .. " crystals)")
            end
        end
    end)
end

--------------------------------------------------------------------------------
-- GAME LOOP
--------------------------------------------------------------------------------

Players.PlayerAdded:Connect(function(player)
    setupPlayer(player)
    player.CharacterAdded:Connect(function(character)
        local data = playerData[player.UserId]
        if data then
            local humanoid = character:FindFirstChild("Humanoid")
            if humanoid then
                humanoid.WalkSpeed = 20
                humanoid.JumpPower = 55
                humanoid.Died:Connect(function()
                    respawnPlayer(player)
                end)
            end
        end
    end)
end)

Players.PlayerRemoving:Connect(cleanupPlayer)

for _, player in ipairs(Players:GetPlayers()) do
    setupPlayer(player)
end

createMap()

RunService.Heartbeat:Connect(function(dt)
    -- Update dynamic elements
    updateMovingPlatforms(dt)
    updateDisappearingPlatforms(dt)

    -- Per-player checks
    for _, player in ipairs(Players:GetPlayers()) do
        local data = playerData[player.UserId]
        if data then
            -- Update zone tracking
            data.zone = getPlayerZone(player)

            -- Check game interactions
            checkHazards(player)
            checkCheckpoints(player)
            checkJumpPads(player)

            -- Auto-collect nearby crystals
            collectNearestCrystal(player)

            -- Update observable attributes
            updatePlayerAttributes(player)
        end
    end
end)

print("Crystal Climb: Sky Realms initialized!")
print("Navigate through 4 zones: Forest -> Lava -> Ice -> Sky Castle")
print("Collect crystals, reach checkpoints, climb to the summit!")
