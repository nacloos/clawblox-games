-- ARENA SURVIVE 🏟️
-- Waves of enemies close in. Shoot to survive. How long can you last?

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local AgentInputService = game:GetService("AgentInputService")
local DataStoreService = game:GetService("DataStoreService")

Workspace.Gravity = 196.2

--------------------------------------------------------------------------------
-- ARENA
--------------------------------------------------------------------------------

local ARENA_RADIUS = 40
local ARENA_WALL_HEIGHT = 8

-- Floor
local floor = Instance.new("Part")
floor.Name = "ArenaFloor"
floor.Size = Vector3.new(ARENA_RADIUS * 2, 1, ARENA_RADIUS * 2)
floor.Position = Vector3.new(0, -0.5, 0)
floor.Anchored = true
floor.Color = Color3.fromRGB(50, 50, 60)
floor:SetAttribute("RenderRole", "ArenaFloor")
floor.Parent = Workspace

-- Arena walls (4 sides)
local wallData = {
    { name = "WallN", pos = {0, ARENA_WALL_HEIGHT/2, -ARENA_RADIUS}, size = {ARENA_RADIUS*2, ARENA_WALL_HEIGHT, 2} },
    { name = "WallS", pos = {0, ARENA_WALL_HEIGHT/2, ARENA_RADIUS},  size = {ARENA_RADIUS*2, ARENA_WALL_HEIGHT, 2} },
    { name = "WallE", pos = {ARENA_RADIUS, ARENA_WALL_HEIGHT/2, 0},  size = {2, ARENA_WALL_HEIGHT, ARENA_RADIUS*2} },
    { name = "WallW", pos = {-ARENA_RADIUS, ARENA_WALL_HEIGHT/2, 0}, size = {2, ARENA_WALL_HEIGHT, ARENA_RADIUS*2} },
}

local walls = {}
for _, w in ipairs(wallData) do
    local wall = Instance.new("Part")
    wall.Name = w.name
    wall.Size = Vector3.new(w.size[1], w.size[2], w.size[3])
    wall.Position = Vector3.new(w.pos[1], w.pos[2], w.pos[3])
    wall.Anchored = true
    wall.Color = Color3.fromRGB(80, 20, 20)
    wall:SetAttribute("RenderRole", "Wall")
    wall.Parent = Workspace
    table.insert(walls, wall)
end

-- Cover pillars
local pillarPositions = {
    {12, 0, 12}, {-12, 0, 12}, {12, 0, -12}, {-12, 0, -12},
    {0, 0, 20}, {0, 0, -20}, {20, 0, 0}, {-20, 0, 0},
}

for i, pp in ipairs(pillarPositions) do
    local pillar = Instance.new("Part")
    pillar.Name = "Pillar" .. i
    pillar.Size = Vector3.new(3, 6, 3)
    pillar.Position = Vector3.new(pp[1], 3, pp[3])
    pillar.Anchored = true
    pillar.Color = Color3.fromRGB(120, 100, 80)
    pillar:SetAttribute("RenderRole", "Pillar")
    pillar.Parent = Workspace
end

--------------------------------------------------------------------------------
-- GAME STATE
--------------------------------------------------------------------------------

local gameState = Instance.new("Folder")
gameState.Name = "GameState"
gameState:SetAttribute("Score", 0)
gameState:SetAttribute("Wave", 0)
gameState:SetAttribute("Kills", 0)
gameState:SetAttribute("Health", 100)
gameState:SetAttribute("MaxHealth", 100)
gameState:SetAttribute("Alive", true)
gameState:SetAttribute("GameOver", false)
gameState:SetAttribute("EnemiesAlive", 0)
gameState:SetAttribute("WaveActive", false)
gameState:SetAttribute("ShootCooldown", 0)
gameState:SetAttribute("ShootDamage", 25)
gameState:SetAttribute("ShootRange", 60)
gameState:SetAttribute("BestScore", 0)
gameState:SetAttribute("BestWave", 0)
gameState:SetAttribute("BestKills", 0)
gameState.Parent = Workspace

--------------------------------------------------------------------------------
-- FORWARD DECLARATIONS
--------------------------------------------------------------------------------

local spawnPowerup  -- defined later in power-up system
local playerHealth = 100
local MAX_HEALTH = 100
local HEALTH_REGEN = 5  -- HP per second during wave breaks
local KILL_HEAL = 3  -- HP restored per kill
local lastDamageTime = 0
local DAMAGE_INVULN = 0.3  -- brief invulnerability after taking damage
local shockwaveCharge = 0
local SHOCKWAVE_MAX_CHARGE = 10
local SHOCKWAVE_RADIUS = 20
local SHOCKWAVE_DAMAGE = 50

--------------------------------------------------------------------------------
-- ENEMY SYSTEM
--------------------------------------------------------------------------------

local enemies = {}
local ENEMY_TYPES = {
    Runner = {
        health = 30,
        speed = 10,
        damage = 8,
        size = {2, 4, 2},
        color = {255, 100, 100},
        points = 10,
        attackCooldown = 0.8,
    },
    Tank = {
        health = 100,
        speed = 5,
        damage = 20,
        size = {3, 5, 3},
        color = {150, 50, 50},
        points = 25,
        attackCooldown = 1.5,
    },
    Dasher = {
        health = 40,
        speed = 6,
        damage = 15,
        size = {2, 3.5, 2},
        color = {255, 150, 50},
        points = 20,
        attackCooldown = 1.0,
        dashSpeed = 30,
        dashCooldown = 4,
        dashDuration = 0.5,
    },
}

local function spawnEnemy(enemyType, position)
    local config = ENEMY_TYPES[enemyType]
    if not config then return end
    
    local enemy = Instance.new("Part")
    enemy.Name = "Enemy"
    enemy.Size = Vector3.new(config.size[1], config.size[2], config.size[3])
    enemy.Position = position
    enemy.Anchored = true
    enemy.CanCollide = false
    enemy.Color = Color3.fromRGB(config.color[1], config.color[2], config.color[3])
    enemy:SetAttribute("RenderRole", "Enemy")
    enemy:SetAttribute("EnemyType", enemyType)
    enemy:SetAttribute("Health", config.health)
    enemy:SetAttribute("MaxHealth", config.health)
    enemy:SetAttribute("Speed", config.speed)
    enemy:SetAttribute("Damage", config.damage)
    enemy:SetAttribute("Points", config.points)
    enemy:SetAttribute("LastAttack", 0)
    enemy:SetAttribute("AttackCooldown", config.attackCooldown)
    
    -- Dasher state
    if enemyType == "Dasher" then
        enemy:SetAttribute("DashCooldown", config.dashCooldown)
        enemy:SetAttribute("DashTimer", config.dashCooldown)
        enemy:SetAttribute("IsDashing", false)
        enemy:SetAttribute("DashDuration", 0)
        enemy:SetAttribute("DashDirX", 0)
        enemy:SetAttribute("DashDirZ", 0)
    end
    
    enemy.Parent = Workspace
    
    local data = {
        part = enemy,
        type = enemyType,
        config = config,
    }
    table.insert(enemies, data)
    gameState:SetAttribute("EnemiesAlive", #enemies)
    return data
end

local function markEnemyDead(index)
    local enemy = enemies[index]
    if not enemy or not enemy.part then return end
    if enemy.dead then return end
    enemy.dead = true
    
    local points = enemy.part:GetAttribute("Points") or 10
    
    -- Update score
    local score = gameState:GetAttribute("Score") + points
    local kills = gameState:GetAttribute("Kills") + 1
    gameState:SetAttribute("Score", score)
    gameState:SetAttribute("Kills", kills)
    
    -- Heal on kill
    playerHealth = math.min(MAX_HEALTH, playerHealth + KILL_HEAL)
    gameState:SetAttribute("Health", math.floor(playerHealth))
    
    print("[KILL] " .. enemy.type .. " destroyed! +" .. points .. "pts +" .. KILL_HEAL .. "HP (Total: " .. score .. ", Kills: " .. kills .. ")")
    
    -- Charge shockwave
    shockwaveCharge = math.min(SHOCKWAVE_MAX_CHARGE, shockwaveCharge + 1)
    gameState:SetAttribute("ShockwaveCharge", shockwaveCharge)
    gameState:SetAttribute("ShockwaveMaxCharge", SHOCKWAVE_MAX_CHARGE)
    
    -- Chance to drop power-up
    spawnPowerup(enemy.part.Position)
end

local function cleanupDeadEnemies()
    for i = #enemies, 1, -1 do
        if enemies[i].dead then
            enemies[i].part:Destroy()
            table.remove(enemies, i)
        end
    end
    gameState:SetAttribute("EnemiesAlive", #enemies)
end

local function getRandomEdgePosition()
    local side = math.random(1, 4)
    local offset = math.random() * (ARENA_RADIUS * 2 - 8) - (ARENA_RADIUS - 4)
    
    if side == 1 then return Vector3.new(offset, 3, -(ARENA_RADIUS - 3))
    elseif side == 2 then return Vector3.new(offset, 3, ARENA_RADIUS - 3)
    elseif side == 3 then return Vector3.new(ARENA_RADIUS - 3, 3, offset)
    else return Vector3.new(-(ARENA_RADIUS - 3), 3, offset) end
end

--------------------------------------------------------------------------------
-- POWER-UP SYSTEM
--------------------------------------------------------------------------------

local powerups = {}
local POWERUP_COLLECT_DIST = 3.5
local POWERUP_LIFETIME = 12  -- seconds before despawn
local DROP_CHANCE = 0.35  -- 35% chance per kill

local POWERUP_TYPES = {
    {
        name = "SpeedBoost",
        color = {50, 200, 255},
        duration = 8,
        description = "+50% speed",
    },
    {
        name = "DamageBoost", 
        color = {255, 50, 50},
        duration = 8,
        description = "2x damage",
    },
    {
        name = "RapidFire",
        color = {255, 255, 50},
        duration = 6,
        description = "3x fire rate",
    },
    {
        name = "HealPack",
        color = {50, 255, 50},
        duration = 0,  -- instant
        description = "+40 HP",
    },
}

-- Active buffs
local activeBuffs = {}

spawnPowerup = function(position)
    if math.random() > DROP_CHANCE then return end  -- random drop chance
    
    local ptype = POWERUP_TYPES[math.random(1, #POWERUP_TYPES)]
    
    local pu = Instance.new("Part")
    pu.Name = "Powerup"
    pu.Shape = Enum.PartType.Ball
    pu.Size = Vector3.new(2, 2, 2)
    pu.Position = Vector3.new(position.X, 2, position.Z)
    pu.Anchored = true
    pu.CanCollide = false
    pu.Color = Color3.fromRGB(ptype.color[1], ptype.color[2], ptype.color[3])
    pu.Material = Enum.Material.Neon
    pu:SetAttribute("RenderRole", "Powerup")
    pu:SetAttribute("PowerupType", ptype.name)
    pu:SetAttribute("SpawnTime", tick())
    pu:SetAttribute("Duration", ptype.duration)
    pu.Parent = Workspace
    
    table.insert(powerups, { part = pu, config = ptype, spawnTime = tick() })
    print("[POWERUP] " .. ptype.name .. " dropped! (" .. ptype.description .. ")")
end

local function applyPowerup(ptype, player)
    if ptype.name == "HealPack" then
        playerHealth = math.min(MAX_HEALTH, playerHealth + 40)
        gameState:SetAttribute("Health", math.floor(playerHealth))
        print("[POWERUP] +40 HP! Now at " .. math.floor(playerHealth))
    else
        -- Timed buff
        activeBuffs[ptype.name] = tick() + ptype.duration
        print("[POWERUP] " .. ptype.name .. " active for " .. ptype.duration .. "s!")
    end
    
    -- Update game state with active buffs
    gameState:SetAttribute("Buff_" .. ptype.name, true)
end

local function isBuffActive(name)
    local expiry = activeBuffs[name]
    if expiry and tick() < expiry then
        return true
    end
    if expiry then
        activeBuffs[name] = nil
        gameState:SetAttribute("Buff_" .. name, false)
    end
    return false
end

local function getShootCooldown()
    if isBuffActive("RapidFire") then return 0.15 end
    return 0.4
end

local function getShootDamage()
    if isBuffActive("DamageBoost") then return 50 end
    return 25
end

local function getPlayerSpeed()
    if isBuffActive("SpeedBoost") then return 24 end
    return 16
end

local function updatePowerups(playerPos, player)
    -- Check collection and despawn
    for i = #powerups, 1, -1 do
        local pu = powerups[i]
        
        -- Despawn after lifetime
        if tick() - pu.spawnTime > POWERUP_LIFETIME then
            pu.part:Destroy()
            table.remove(powerups, i)
        else
            -- Collection check
            local dist = (pu.part.Position - playerPos).Magnitude
            if dist < POWERUP_COLLECT_DIST then
                applyPowerup(pu.config, player)
                pu.part:Destroy()
                table.remove(powerups, i)
            end
        end
    end
end

--------------------------------------------------------------------------------
-- WAVE SYSTEM
--------------------------------------------------------------------------------

local waveTimer = 3  -- seconds before first wave
local waveActive = false
local waveStartTime = 0
local betweenWaves = true

local WAVE_CONFIGS = {
    -- Wave: {Runner, Tank, Dasher}
    [1]  = {3, 0, 0},
    [2]  = {4, 0, 0},
    [3]  = {3, 1, 0},
    [4]  = {5, 1, 0},
    [5]  = {4, 1, 1},
    [6]  = {5, 2, 1},
    [7]  = {6, 2, 2},
    [8]  = {7, 3, 2},
    [9]  = {8, 3, 3},
    [10] = {10, 4, 4},
}

local function getWaveConfig(wave)
    if wave <= #WAVE_CONFIGS then
        return WAVE_CONFIGS[wave]
    end
    -- Past wave 10: scale infinitely
    local base = WAVE_CONFIGS[10]
    local extra = wave - 10
    return {
        base[1] + extra * 2,
        base[2] + extra,
        base[3] + extra,
    }
end

local function startWave(waveNum)
    local config = getWaveConfig(waveNum)
    print("=== WAVE " .. waveNum .. " === Runners:" .. config[1] .. " Tanks:" .. config[2] .. " Dashers:" .. config[3])
    
    gameState:SetAttribute("Wave", waveNum)
    gameState:SetAttribute("WaveActive", true)
    waveActive = true
    waveStartTime = tick()
    betweenWaves = false
    
    -- Spawn enemies with slight delays
    local totalEnemies = config[1] + config[2] + config[3]
    local spawned = 0
    
    -- Spawn runners
    for i = 1, config[1] do
        task.delay(i * 0.3, function()
            if gameState:GetAttribute("GameOver") then return end
            spawnEnemy("Runner", getRandomEdgePosition())
        end)
    end
    
    -- Spawn tanks
    for i = 1, config[2] do
        task.delay(config[1] * 0.3 + i * 0.5, function()
            if gameState:GetAttribute("GameOver") then return end
            spawnEnemy("Tank", getRandomEdgePosition())
        end)
    end
    
    -- Spawn dashers
    for i = 1, config[3] do
        task.delay(config[1] * 0.3 + config[2] * 0.5 + i * 0.4, function()
            if gameState:GetAttribute("GameOver") then return end
            spawnEnemy("Dasher", getRandomEdgePosition())
        end)
    end
end

--------------------------------------------------------------------------------
-- SHOOTING SYSTEM
--------------------------------------------------------------------------------

local lastShootTime = 0

local function createBulletTrail(from, to, hit)
    -- Visual bullet trail part (disappears quickly)
    local trail = Instance.new("Part")
    trail.Name = "BulletTrail"
    trail.Anchored = true
    trail.CanCollide = false
    
    local mid = Vector3.new((from.X + to.X)/2, (from.Y + to.Y)/2, (from.Z + to.Z)/2)
    local dist = (to - from).Magnitude
    
    trail.Size = Vector3.new(0.2, 0.2, dist)
    trail.Position = mid
    trail.Color = hit and Color3.fromRGB(255, 255, 100) or Color3.fromRGB(200, 200, 255)
    trail.Material = Enum.Material.Neon
    trail.Transparency = 0.3
    trail:SetAttribute("RenderRole", "BulletTrail")
    trail:SetAttribute("SpawnTime", tick())
    trail:SetAttribute("HitEnemy", hit and true or false)
    
    -- Look from 'from' toward 'to'
    local dir = (to - from).Unit
    trail.CFrame = CFrame.lookAt(mid, mid + dir)
    
    trail.Parent = Workspace
    
    -- Auto destroy after 0.15s
    task.delay(0.15, function()
        trail:Destroy()
    end)
end

local function shoot(player, dirX, dirZ)
    local now = tick()
    local cooldown = getShootCooldown()
    if now - lastShootTime < cooldown then return end
    lastShootTime = now
    
    local character = player.Character
    if not character then return end
    local hrp = character:FindFirstChild("HumanoidRootPart")
    if not hrp then return end
    
    local playerPos = hrp.Position
    local shootRange = gameState:GetAttribute("ShootRange") or 60
    local shootDamage = getShootDamage()
    
    -- Normalize direction
    local mag = math.sqrt(dirX * dirX + dirZ * dirZ)
    if mag < 0.01 then return end  -- no direction
    dirX = dirX / mag
    dirZ = dirZ / mag
    
    local origin = Vector3.new(playerPos.X, playerPos.Y, playerPos.Z)
    local direction = Vector3.new(dirX, 0, dirZ)
    local endPoint = origin + direction * shootRange
    
    -- Check each enemy for hit (simple distance-to-line check)
    local bestHit = nil
    local bestDist = shootRange
    
    for i, enemy in ipairs(enemies) do
        if not enemy or enemy.dead then continue end
        if not enemy.part then continue end
        local ePos = enemy.part.Position
        -- Vector from origin to enemy
        local toEnemy = ePos - origin
        -- Project onto shoot direction
        local proj = toEnemy:Dot(direction)
        
        if proj > 0 and proj < shootRange then
            -- Closest point on ray to enemy
            local closestPoint = origin + direction * proj
            local dist = (closestPoint - ePos).Magnitude
            local hitRadius = enemy.config.size[1] / 2 + 0.5  -- half width + tolerance
            
            if dist < hitRadius and proj < bestDist then
                bestHit = i
                bestDist = proj
            end
        end
    end
    
    if bestHit then
        local enemy = enemies[bestHit]
        local hp = enemy.part:GetAttribute("Health") - shootDamage
        enemy.part:SetAttribute("Health", hp)
        
        local hitPoint = origin + direction * bestDist
        createBulletTrail(origin, hitPoint, true)
        
        print("[SHOOT] Hit " .. enemy.type .. "! HP: " .. hp .. "/" .. enemy.config.health)
        
        if hp <= 0 then
            markEnemyDead(bestHit)
        end
    else
        createBulletTrail(origin, endPoint, false)
    end
    
    gameState:SetAttribute("ShootCooldown", SHOOT_COOLDOWN)
end

--------------------------------------------------------------------------------
-- PLAYER
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- SHOCKWAVE ABILITY
--------------------------------------------------------------------------------

local function useShockwave(playerPos)
    if shockwaveCharge < SHOCKWAVE_MAX_CHARGE then return false end
    
    shockwaveCharge = 0
    gameState:SetAttribute("ShockwaveCharge", 0)
    
    -- Create visual shockwave ring
    local ring = Instance.new("Part")
    ring.Name = "Shockwave"
    ring.Shape = Enum.PartType.Cylinder
    ring.Size = Vector3.new(1, SHOCKWAVE_RADIUS * 2, SHOCKWAVE_RADIUS * 2)
    ring.Position = Vector3.new(playerPos.X, 2, playerPos.Z)
    ring.Anchored = true
    ring.CanCollide = false
    ring.Color = Color3.fromRGB(100, 150, 255)
    ring.Material = Enum.Material.Neon
    ring.Transparency = 0.5
    ring:SetAttribute("RenderRole", "Shockwave")
    ring:SetAttribute("SpawnTime", tick())
    ring.Parent = Workspace
    
    task.delay(0.5, function()
        ring:Destroy()
    end)
    
    -- Damage all enemies in radius
    local hitCount = 0
    for i, enemy in ipairs(enemies) do
        if not enemy or enemy.dead then continue end
        if not enemy.part then continue end
        
        local dist = (enemy.part.Position - playerPos).Magnitude
        if dist < SHOCKWAVE_RADIUS then
            local hp = enemy.part:GetAttribute("Health") - SHOCKWAVE_DAMAGE
            enemy.part:SetAttribute("Health", hp)
            hitCount = hitCount + 1
            
            if hp <= 0 then
                markEnemyDead(i)
            end
        end
    end
    
    print("[SHOCKWAVE] 💥💥💥 Hit " .. hitCount .. " enemies!")
    return true
end

--------------------------------------------------------------------------------
-- PLAYER DAMAGE
--------------------------------------------------------------------------------

local function damagePlayer(amount)
    local now = tick()
    if now - lastDamageTime < DAMAGE_INVULN then return end
    lastDamageTime = now
    
    playerHealth = playerHealth - amount
    if playerHealth < 0 then playerHealth = 0 end
    
    gameState:SetAttribute("Health", playerHealth)
    
    if playerHealth <= 0 then
        -- GAME OVER
        local score = gameState:GetAttribute("Score")
        local wave = gameState:GetAttribute("Wave")
        local kills = gameState:GetAttribute("Kills")
        
        if score > gameState:GetAttribute("BestScore") then
            gameState:SetAttribute("BestScore", score)
        end
        if wave > gameState:GetAttribute("BestWave") then
            gameState:SetAttribute("BestWave", wave)
        end
        if kills > gameState:GetAttribute("BestKills") then
            gameState:SetAttribute("BestKills", kills)
        end
        
        gameState:SetAttribute("Alive", false)
        gameState:SetAttribute("GameOver", true)
        
        print("========================================")
        print("💀 GAME OVER 💀")
        print("Score: " .. score .. " | Wave: " .. wave .. " | Kills: " .. kills)
        print("Best: " .. gameState:GetAttribute("BestScore") .. " pts, Wave " .. gameState:GetAttribute("BestWave"))
        print("========================================")
        
        -- Save to leaderboard
        task.spawn(function()
            local leaderboard = DataStoreService:GetOrderedDataStore("ArenaLeaderboard")
            local timestamp = math.floor(tick())
            local key = "run_" .. timestamp
            leaderboard:SetAsync(key, { score = score })
            print("[LEADERBOARD] Saved run: " .. score .. " pts")
            
            -- Show top scores
            local top = leaderboard:GetSortedAsync(false, 5)
            if top and #top > 0 then
                print("[LEADERBOARD] === TOP SCORES ===")
                for rank, entry in ipairs(top) do
                    print("  #" .. rank .. ": " .. entry.value.score .. " pts")
                end
            end
        end)
        
        -- Clear enemies
        for i = #enemies, 1, -1 do
            enemies[i].part:Destroy()
            table.remove(enemies, i)
        end
    end
end

local function setupPlayer(player)
    local character = player.Character
    if not character then return end
    
    local humanoid = character:FindFirstChild("Humanoid")
    if humanoid then
        humanoid.WalkSpeed = 16
        humanoid.JumpPower = 50
    end
    
    character:SetAttribute("ModelUrl", "asset://player.glb")
    local hrp = character:FindFirstChild("HumanoidRootPart")
    if hrp then
        hrp:SetAttribute("ModelYawOffsetDeg", 180)
        hrp.Position = Vector3.new(0, 5, 0)
        hrp:SetAttribute("Score", 0)
        hrp:SetAttribute("Kills", 0)
        hrp:SetAttribute("Health", MAX_HEALTH)
        hrp:SetAttribute("Alive", true)
    end
    
    -- Reset game
    playerHealth = MAX_HEALTH
    gameState:SetAttribute("Score", 0)
    gameState:SetAttribute("Wave", 0)
    gameState:SetAttribute("Kills", 0)
    gameState:SetAttribute("Health", MAX_HEALTH)
    gameState:SetAttribute("MaxHealth", MAX_HEALTH)
    gameState:SetAttribute("Alive", true)
    gameState:SetAttribute("GameOver", false)
    gameState:SetAttribute("WaveActive", false)
    gameState:SetAttribute("ShootDamage", 25)
    gameState:SetAttribute("ShootRange", 60)
    
    waveTimer = 3
    waveActive = false
    betweenWaves = true
    lastShootTime = 0
    
    -- Clear existing enemies
    for i = #enemies, 1, -1 do
        enemies[i].part:Destroy()
        table.remove(enemies, i)
    end
    
    -- Clear powerups
    for i = #powerups, 1, -1 do
        powerups[i].part:Destroy()
        table.remove(powerups, i)
    end
    activeBuffs = {}
    shockwaveCharge = 0
    gameState:SetAttribute("ShockwaveCharge", 0)
    gameState:SetAttribute("ShockwaveMaxCharge", SHOCKWAVE_MAX_CHARGE)
    
    -- ===== HUD =====
    local playerGui = player.PlayerGui
    if playerGui then
        -- Clear existing GUI
        for _, child in ipairs(playerGui:GetChildren()) do
            child:Destroy()
        end
        
        local screenGui = Instance.new("ScreenGui")
        screenGui.Name = "ArenaHUD"
        screenGui.Parent = playerGui
        
        -- Health bar background
        local hpBg = Instance.new("Frame")
        hpBg.Name = "HealthBg"
        hpBg.Size = UDim2.fromOffset(300, 25)
        hpBg.Position = UDim2.fromOffset(20, 20)
        hpBg.BackgroundColor3 = Color3.fromRGB(40, 10, 10)
        hpBg.BorderSizePixel = 0
        hpBg.Parent = screenGui
        
        -- Health bar fill
        local hpFill = Instance.new("Frame")
        hpFill.Name = "HealthFill"
        hpFill.Size = UDim2.fromScale(1, 1)
        hpFill.BackgroundColor3 = Color3.fromRGB(200, 40, 40)
        hpFill.BorderSizePixel = 0
        hpFill.Parent = hpBg
        
        -- HP text
        local hpText = Instance.new("TextLabel")
        hpText.Name = "HealthText"
        hpText.Size = UDim2.fromScale(1, 1)
        hpText.BackgroundTransparency = 1
        hpText.Text = "100/100"
        hpText.TextColor3 = Color3.new(1, 1, 1)
        hpText.TextSize = 16
        hpText.Parent = hpBg
        
        -- Score display
        local scoreLabel = Instance.new("TextLabel")
        scoreLabel.Name = "ScoreLabel"
        scoreLabel.Size = UDim2.fromOffset(200, 30)
        scoreLabel.Position = UDim2.fromOffset(20, 55)
        scoreLabel.BackgroundTransparency = 1
        scoreLabel.Text = "Score: 0"
        scoreLabel.TextColor3 = Color3.fromRGB(255, 215, 0)
        scoreLabel.TextSize = 22
        scoreLabel.TextXAlignment = "Left"
        scoreLabel.Parent = screenGui
        
        -- Wave display  
        local waveLabel = Instance.new("TextLabel")
        waveLabel.Name = "WaveLabel"
        waveLabel.Size = UDim2.fromOffset(200, 40)
        waveLabel.Position = UDim2.new(0.5, -100, 0, 10)
        waveLabel.BackgroundTransparency = 1
        waveLabel.Text = "WAVE 0"
        waveLabel.TextColor3 = Color3.fromRGB(255, 100, 100)
        waveLabel.TextSize = 28
        waveLabel.Parent = screenGui
        
        -- Kills display
        local killsLabel = Instance.new("TextLabel")
        killsLabel.Name = "KillsLabel"
        killsLabel.Size = UDim2.fromOffset(150, 30)
        killsLabel.Position = UDim2.fromOffset(20, 85)
        killsLabel.BackgroundTransparency = 1
        killsLabel.Text = "Kills: 0"
        killsLabel.TextColor3 = Color3.fromRGB(200, 200, 200)
        killsLabel.TextSize = 18
        killsLabel.TextXAlignment = "Left"
        killsLabel.Parent = screenGui
        
        -- Buff indicators (bottom left)
        local buffFrame = Instance.new("Frame")
        buffFrame.Name = "BuffFrame"
        buffFrame.Size = UDim2.fromOffset(300, 30)
        buffFrame.Position = UDim2.fromOffset(20, 120)
        buffFrame.BackgroundTransparency = 1
        buffFrame.Parent = screenGui
    end
    
    print("=== 🏟️ ARENA SURVIVE 🏟️ ===")
    print("Enemies incoming in 3 seconds...")
    print("Shoot: send direction to fire!")
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

local function getHumanoid(player)
    local character = player.Character
    if character then return character:FindFirstChild("Humanoid") end
    return nil
end

if AgentInputService then
    AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
        local humanoid = getHumanoid(player)
        if not humanoid then return end
        
        if gameState:GetAttribute("GameOver") then return end
        
        if inputType == "MoveTo" and inputData and inputData.position then
            local pos = inputData.position
            humanoid:MoveTo(Vector3.new(pos[1], pos[2], pos[3]))
        elseif inputType == "Stop" then
            humanoid:CancelMoveTo()
        elseif inputType == "Jump" then
            humanoid.Jump = true
        elseif inputType == "Shoot" and inputData then
            local dx = inputData.direction and inputData.direction[1] or 0
            local dz = inputData.direction and inputData.direction[2] or 0
            shoot(player, dx, dz)
        elseif inputType == "Shockwave" then
            local character = player.Character
            if character then
                local hrp = character:FindFirstChild("HumanoidRootPart")
                if hrp then
                    useShockwave(hrp.Position)
                end
            end
        end
    end)
end

--------------------------------------------------------------------------------
-- MAIN LOOP
--------------------------------------------------------------------------------

local gameStartTime = tick()

RunService.Heartbeat:Connect(function(dt)
    if gameState:GetAttribute("GameOver") then return end
    
    -- Clean up any enemies killed since last frame
    cleanupDeadEnemies()
    
    local gameTime = tick() - gameStartTime
    
    -- Wave management
    if betweenWaves then
        waveTimer = waveTimer - dt
        if waveTimer <= 0 then
            local nextWave = gameState:GetAttribute("Wave") + 1
            startWave(nextWave)
        end
        
        -- Health regen between waves
        if playerHealth < MAX_HEALTH then
            playerHealth = math.min(MAX_HEALTH, playerHealth + HEALTH_REGEN * dt)
            gameState:SetAttribute("Health", math.floor(playerHealth))
        end
    end
    
    -- Check if wave is cleared
    if waveActive and #enemies == 0 then
        waveActive = false
        betweenWaves = true
        waveTimer = 4  -- 4 seconds between waves
        
        local wave = gameState:GetAttribute("Wave")
        local bonus = wave * 50
        local score = gameState:GetAttribute("Score") + bonus
        gameState:SetAttribute("Score", score)
        gameState:SetAttribute("WaveActive", false)
        
        print("[WAVE CLEAR] Wave " .. wave .. " cleared! +" .. bonus .. " bonus! (Total: " .. score .. ")")
        print("Next wave in 4 seconds... (Health regen active)")
    end
    
    -- Update shoot cooldown display
    local cd = math.max(0, getShootCooldown() - (tick() - lastShootTime))
    gameState:SetAttribute("ShootCooldown", cd)
    
    -- Update active buffs display
    gameState:SetAttribute("ShootDamage", getShootDamage())
    gameState:SetAttribute("CurrentSpeed", getPlayerSpeed())
    
    -- Update enemies
    for _, player in ipairs(Players:GetPlayers()) do
        local character = player.Character
        if not character then return end
        local hrp = character:FindFirstChild("HumanoidRootPart")
        if not hrp then return end
        
        local playerPos = hrp.Position
        
        for i = #enemies, 1, -1 do
            local enemy = enemies[i]
            if not enemy or enemy.dead then continue end
            if not enemy.part then continue end
            local ePos = enemy.part.Position
            local toPlayer = playerPos - ePos
            local distXZ = math.sqrt(toPlayer.X * toPlayer.X + toPlayer.Z * toPlayer.Z)
            
            -- Enemy movement
            if distXZ > 1.5 then
                local dirX = toPlayer.X / distXZ
                local dirZ = toPlayer.Z / distXZ
                local speed = enemy.part:GetAttribute("Speed") or enemy.config.speed
                
                -- Dasher logic
                if enemy.type == "Dasher" then
                    local dashTimer = enemy.part:GetAttribute("DashTimer") or 0
                    local isDashing = enemy.part:GetAttribute("IsDashing") or false
                    
                    if isDashing then
                        local dur = enemy.part:GetAttribute("DashDuration") or 0
                        dur = dur - dt
                        if dur <= 0 then
                            enemy.part:SetAttribute("IsDashing", false)
                            enemy.part:SetAttribute("DashTimer", enemy.config.dashCooldown)
                        else
                            enemy.part:SetAttribute("DashDuration", dur)
                            -- Dash in stored direction
                            local ddx = enemy.part:GetAttribute("DashDirX") or dirX
                            local ddz = enemy.part:GetAttribute("DashDirZ") or dirZ
                            speed = enemy.config.dashSpeed
                            dirX = ddx
                            dirZ = ddz
                        end
                    else
                        dashTimer = dashTimer - dt
                        if dashTimer <= 0 and distXZ < 20 then
                            -- Start dash!
                            enemy.part:SetAttribute("IsDashing", true)
                            enemy.part:SetAttribute("DashDuration", 0.5)
                            enemy.part:SetAttribute("DashDirX", dirX)
                            enemy.part:SetAttribute("DashDirZ", dirZ)
                            speed = enemy.config.dashSpeed
                            print("[DASH] Dasher charges!")
                        else
                            enemy.part:SetAttribute("DashTimer", dashTimer)
                        end
                    end
                end
                
                -- Move enemy
                local newX = ePos.X + dirX * speed * dt
                local newZ = ePos.Z + dirZ * speed * dt
                
                -- Keep in arena bounds
                local bound = ARENA_RADIUS - 2
                newX = math.max(-bound, math.min(bound, newX))
                newZ = math.max(-bound, math.min(bound, newZ))
                
                enemy.part.Position = Vector3.new(newX, ePos.Y, newZ)
            end
            
            -- Contact damage
            if distXZ < 2.5 then
                local now = tick()
                local lastAtk = enemy.part:GetAttribute("LastAttack") or 0
                local atkCD = enemy.part:GetAttribute("AttackCooldown") or 1
                
                if now - lastAtk > atkCD then
                    enemy.part:SetAttribute("LastAttack", now)
                    local dmg = enemy.part:GetAttribute("Damage") or 10
                    damagePlayer(dmg)
                    print("[HIT] " .. enemy.type .. " hits you for " .. dmg .. "! HP: " .. math.floor(playerHealth) .. "/" .. MAX_HEALTH)
                end
            end
        end
        
        -- Update powerups
        updatePowerups(playerPos, player)
        
        -- Apply speed buff to humanoid
        local humanoid = character:FindFirstChild("Humanoid")
        if humanoid then
            humanoid.WalkSpeed = getPlayerSpeed()
        end
        
        -- Sync player attributes
        hrp:SetAttribute("Score", gameState:GetAttribute("Score"))
        hrp:SetAttribute("Kills", gameState:GetAttribute("Kills"))
        hrp:SetAttribute("Health", math.floor(playerHealth))
        
        -- Update HUD
        local playerGui = player.PlayerGui
        if playerGui then
            local screenGui = playerGui:FindFirstChild("ArenaHUD")
            if screenGui then
                local hpBg = screenGui:FindFirstChild("HealthBg")
                if hpBg then
                    local hpFill = hpBg:FindFirstChild("HealthFill")
                    local hpText = hpBg:FindFirstChild("HealthText")
                    if hpFill then
                        local ratio = math.max(0, playerHealth / MAX_HEALTH)
                        hpFill.Size = UDim2.fromScale(ratio, 1)
                        -- Color: green > yellow > red based on health
                        if ratio > 0.6 then
                            hpFill.BackgroundColor3 = Color3.fromRGB(40, 200, 40)
                        elseif ratio > 0.3 then
                            hpFill.BackgroundColor3 = Color3.fromRGB(200, 200, 40)
                        else
                            hpFill.BackgroundColor3 = Color3.fromRGB(200, 40, 40)
                        end
                    end
                    if hpText then
                        hpText.Text = math.floor(playerHealth) .. "/" .. MAX_HEALTH
                    end
                end
                
                local scoreLabel = screenGui:FindFirstChild("ScoreLabel")
                if scoreLabel then
                    scoreLabel.Text = "Score: " .. gameState:GetAttribute("Score")
                end
                
                local waveLabel = screenGui:FindFirstChild("WaveLabel")
                if waveLabel then
                    local w = gameState:GetAttribute("Wave")
                    if w > 0 then
                        waveLabel.Text = "WAVE " .. w
                    else
                        waveLabel.Text = "GET READY..."
                    end
                end
                
                local killsLabel = screenGui:FindFirstChild("KillsLabel")
                if killsLabel then
                    killsLabel.Text = "Kills: " .. gameState:GetAttribute("Kills")
                end
            end
        end
    end
end)

--------------------------------------------------------------------------------
-- INITIALIZATION
--------------------------------------------------------------------------------

Players.PlayerAdded:Connect(setupPlayer)
for _, player in ipairs(Players:GetPlayers()) do
    setupPlayer(player)
end

print("=== 🏟️ ARENA SURVIVE 🏟️ ===")
print("Survive the waves! Shoot to kill!")
print("First wave in 3 seconds...")
