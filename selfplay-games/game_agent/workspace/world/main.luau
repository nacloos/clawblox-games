-- The world - LAVA RISING Edition
-- The floor is lava! A glowing lava plane rises over time.
-- Collect coins on structures before they're swallowed.
-- Survive as long as you can. Touch lava = reset.

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local AgentInputService = game:GetService("AgentInputService")

Workspace.Gravity = 196.2

--------------------------------------------------------------------------------
-- GROUND
--------------------------------------------------------------------------------

local ground = Instance.new("Part")
ground.Name = "Ground"
ground.Size = Vector3.new(100, 1, 100)
ground.Position = Vector3.new(0, -0.5, 0)
ground.Anchored = true
ground.Color = Color3.fromRGB(85, 239, 196)
ground:SetAttribute("RenderRole", "Ground")
ground.Parent = Workspace

local mesas = {
    -- Ground-level formations
    { name = "LowStep",       size = {8, 2, 10},     pos = {8, 1, 18} },
    { name = "LargeMesa",     size = {20, 4, 16},    pos = {20, 2, 20} },
    { name = "SmallPlateau",  size = {10, 2, 8},     pos = {-30, 1, 28} },
    { name = "SteppingStone", size = {8, 2.5, 8},    pos = {-18, 1.25, -12} },
    { name = "Ridge",         size = {6, 3, 25},     pos = {35, 1.5, -10} },
    { name = "TallMesa",      size = {12, 6, 10},    pos = {-25, 3, -20} },
    -- NE climbing path: large mesa (4) -> high shelf (7) -> peak (11)
    { name = "HighShelf",     size = {10, 7, 8},     pos = {25, 3.5, 28} },
    { name = "Peak",          size = {5, 11, 5},     pos = {28, 5.5, 32} },
    -- SW climbing path: tall mesa (6) -> tower base (7) -> summit (10) -> spire (13.5)
    { name = "TowerBase",     size = {8, 7, 8},      pos = {-28, 3.5, -26} },
    { name = "Summit",        size = {6, 10, 6},     pos = {-28, 5, -30} },
    { name = "Spire",         size = {4, 13.5, 4},   pos = {-30, 6.75, -33} },
}

-- Store mesa data for coin spawning and lava checks
local mesaData = {}

for _, m in ipairs(mesas) do
    local mesa = Instance.new("Part")
    mesa.Name = m.name
    mesa.Size = Vector3.new(m.size[1], m.size[2], m.size[3])
    mesa.Position = Vector3.new(m.pos[1], m.pos[2], m.pos[3])
    mesa.Anchored = true
    mesa.Color = Color3.fromRGB(200, 160, 100)
    mesa:SetAttribute("RenderRole", "Mesa")
    mesa.Parent = Workspace

    local topY = m.pos[2] + m.size[2] / 2
    table.insert(mesaData, {
        name = m.name,
        topY = topY,
        centerX = m.pos[1],
        centerZ = m.pos[3],
        halfW = m.size[1] / 2 - 1,
        halfD = m.size[3] / 2 - 1,
    })
end

-- Also allow coins on ground
table.insert(mesaData, {
    name = "Ground",
    topY = 0,
    centerX = 0,
    centerZ = 0,
    halfW = 40,
    halfD = 40,
})

--------------------------------------------------------------------------------
-- LAVA SYSTEM
--------------------------------------------------------------------------------

local LAVA_START_Y = -1          -- starts below ground
local LAVA_RISE_SPEED = 0.4      -- units per second (faster = more tension)
local LAVA_DAMAGE_INTERVAL = 0.5 -- how often lava hurts
local LAVA_PAUSE_AT_START = 5    -- seconds before lava starts rising

local lava = Instance.new("Part")
lava.Name = "Lava"
lava.Size = Vector3.new(200, 1, 200)  -- extends well past the ground
lava.Position = Vector3.new(0, LAVA_START_Y, 0)
lava.Anchored = true
lava.CanCollide = false
lava.Color = Color3.fromRGB(255, 69, 0)
lava.Material = Enum.Material.Neon
lava.Transparency = 0.3
lava:SetAttribute("RenderRole", "Lava")
lava:SetAttribute("LavaY", LAVA_START_Y)
lava.Parent = Workspace

local lavaY = LAVA_START_Y
local lavaActive = false
local lavaStartTime = 0
local lastDamageTick = 0

--------------------------------------------------------------------------------
-- COIN SYSTEM
--------------------------------------------------------------------------------

local coins = {}
local MAX_COINS = 5
local COIN_COLLECT_DIST = 3.5
local COIN_SIZE = Vector3.new(2, 2, 2)

local gameState = Instance.new("Folder")
gameState.Name = "GameState"
gameState:SetAttribute("Score", 0)
gameState:SetAttribute("CoinsCollected", 0)
gameState:SetAttribute("GameTime", 0)
gameState:SetAttribute("LavaY", LAVA_START_Y)
gameState:SetAttribute("Wave", 1)
gameState:SetAttribute("Alive", true)
gameState:SetAttribute("BestScore", 0)
gameState:SetAttribute("BestWave", 0)
gameState:SetAttribute("BestSurvivalTime", 0)
gameState.Parent = Workspace

local function getAboveLavaMesas()
    -- Only spawn coins on structures whose tops are above the lava
    local valid = {}
    for _, m in ipairs(mesaData) do
        if m.topY > lavaY + 1 then
            table.insert(valid, m)
        end
    end
    return valid
end

local function randomCoinPosition()
    local validMesas = getAboveLavaMesas()
    if #validMesas == 0 then
        -- Everything is submerged, spawn above Spire
        return Vector3.new(-30, lavaY + 3, -33), "Spire"
    end
    
    local m = validMesas[math.random(1, #validMesas)]
    local x = m.centerX + (math.random() * 2 - 1) * m.halfW
    local z = m.centerZ + (math.random() * 2 - 1) * m.halfD
    local y = math.max(m.topY, lavaY) + 1.5  -- always above lava
    
    return Vector3.new(x, y, z), m.name
end

local function spawnCoin()
    if #coins >= MAX_COINS then return end
    
    local pos, locationName = randomCoinPosition()
    
    local coin = Instance.new("Part")
    coin.Name = "Coin"
    coin.Shape = Enum.PartType.Cylinder
    coin.Size = COIN_SIZE
    coin.Position = pos
    coin.Anchored = true
    coin.CanCollide = false
    coin.Color = Color3.fromRGB(255, 215, 0)
    coin.Material = Enum.Material.Neon
    coin:SetAttribute("RenderRole", "Coin")
    coin:SetAttribute("Location", locationName)
    coin:SetAttribute("SpawnTick", tick())
    
    -- Points scale with height, wave gives smaller bonus
    local wave = gameState:GetAttribute("Wave")
    local pointValue = math.floor(pos.Y / 2) + 1
    if pointValue < 1 then pointValue = 1 end
    -- Wave bonus: +50% per wave (capped at 3x)
    local waveMultiplier = math.min(3, 1 + (wave - 1) * 0.5)
    pointValue = math.floor(pointValue * waveMultiplier)
    coin:SetAttribute("Points", pointValue)
    
    coin.Parent = Workspace
    table.insert(coins, coin)
end

local function collectCoin(coinIndex, player)
    local coin = coins[coinIndex]
    local points = coin:GetAttribute("Points") or 1
    local location = coin:GetAttribute("Location") or "?"
    
    local score = gameState:GetAttribute("Score") + points
    local collected = gameState:GetAttribute("CoinsCollected") + 1
    gameState:SetAttribute("Score", score)
    gameState:SetAttribute("CoinsCollected", collected)
    
    if player and player.Character then
        local hrp = player.Character:FindFirstChild("HumanoidRootPart")
        if hrp then
            hrp:SetAttribute("Score", score)
            hrp:SetAttribute("CoinsCollected", collected)
            hrp:SetAttribute("LastCoinLocation", location)
            hrp:SetAttribute("LastCoinPoints", points)
        end
    end
    
    print("[COIN] +" .. points .. " on " .. location .. " (Total: " .. score .. ")")
    
    coin:Destroy()
    table.remove(coins, coinIndex)
end

-- Remove coins that are now below lava
local function purgeDrownedCoins()
    for i = #coins, 1, -1 do
        local coin = coins[i]
        if coin.Position.Y < lavaY + 0.5 then
            print("[LAVA] Coin on " .. (coin:GetAttribute("Location") or "?") .. " swallowed!")
            coin:Destroy()
            table.remove(coins, i)
        end
    end
end

-- Danger Coin: high-value red coin on the structure closest to the lava line
local dangerCoin = nil
local lastDangerSpawn = -999  -- allow first spawn immediately after lava starts
local DANGER_COOLDOWN = 10  -- seconds between danger coin spawns

local function spawnDangerCoin()
    if dangerCoin then return end
    if gameOver then return end
    
    -- Find the lowest structure that's still just above lava
    local bestMesa = nil
    local bestDiff = 999
    for _, m in ipairs(mesaData) do
        if m.name == "Ground" then
            -- Skip ground, too easy/boring
        else
            local diff = m.topY - lavaY
            if diff > 0.5 and diff < bestDiff then
                bestDiff = diff
                bestMesa = m
            end
        end
    end
    
    if not bestMesa then return end
    
    local x = bestMesa.centerX
    local z = bestMesa.centerZ
    local y = bestMesa.topY + 2
    
    local wave = gameState:GetAttribute("Wave")
    local points = 50 * math.min(3, 1 + (wave - 1) * 0.5)  -- 50-150 points!
    
    dangerCoin = Instance.new("Part")
    dangerCoin.Name = "DangerCoin"
    dangerCoin.Shape = Enum.PartType.Cylinder
    dangerCoin.Size = Vector3.new(3, 3, 3)  -- bigger than normal
    dangerCoin.Position = Vector3.new(x, y, z)
    dangerCoin.Anchored = true
    dangerCoin.CanCollide = false
    dangerCoin.Color = Color3.fromRGB(255, 50, 50)  -- RED
    dangerCoin.Material = Enum.Material.Neon
    dangerCoin:SetAttribute("RenderRole", "DangerCoin")
    dangerCoin:SetAttribute("Location", bestMesa.name)
    dangerCoin:SetAttribute("Points", math.floor(points))
    dangerCoin:SetAttribute("SpawnTick", tick())
    dangerCoin.Parent = Workspace
    
    print("[DANGER] 💎 " .. math.floor(points) .. "pt coin on " .. bestMesa.name .. "! (lava is " .. string.format("%.1f", bestDiff) .. " below)")
    lastDangerSpawn = tick()
end

local function checkDangerCoin(playerPos, player)
    if not dangerCoin then return end
    
    -- Check if drowned
    if dangerCoin.Position.Y < lavaY + 0.5 then
        print("[DANGER] 💎 Danger coin on " .. (dangerCoin:GetAttribute("Location") or "?") .. " swallowed by lava!")
        dangerCoin:Destroy()
        dangerCoin = nil
        return
    end
    
    -- Check collection
    local dist = (dangerCoin.Position - playerPos).Magnitude
    if dist < 4 then
        local points = dangerCoin:GetAttribute("Points") or 50
        local location = dangerCoin:GetAttribute("Location") or "?"
        
        local score = gameState:GetAttribute("Score") + points
        local collected = gameState:GetAttribute("CoinsCollected") + 1
        gameState:SetAttribute("Score", score)
        gameState:SetAttribute("CoinsCollected", collected)
        
        if player and player.Character then
            local hrp = player.Character:FindFirstChild("HumanoidRootPart")
            if hrp then
                hrp:SetAttribute("Score", score)
                hrp:SetAttribute("CoinsCollected", collected)
                hrp:SetAttribute("LastCoinLocation", location)
                hrp:SetAttribute("LastCoinPoints", points)
            end
        end
        
        print("[DANGER] 💎💎💎 DANGER COIN COLLECTED! +" .. points .. " on " .. location .. " (Total: " .. score .. ")")
        dangerCoin:Destroy()
        dangerCoin = nil
    end
end

-- Initialize coins
for i = 1, MAX_COINS do
    spawnCoin()
end

--------------------------------------------------------------------------------
-- WAVE SYSTEM
--------------------------------------------------------------------------------

-- Lava rises in waves. Each wave:
-- 1. Lava rises to the next structure height
-- 2. Brief pause at that level
-- 3. Continue rising

local waveTargets = {0, 2, 2.5, 3, 4, 6, 7, 10, 11, 13.5}
-- Ground, LowStep/SmallPlateau, SteppingStone, Ridge, LargeMesa, TallMesa, 
-- TowerBase/HighShelf, Summit, Peak, Spire (GAME OVER when lava reaches Spire top)
local currentWaveIndex = 1
local wavePauseTimer = 0
local WAVE_PAUSE_DURATION = 5  -- seconds to breathe between waves
local isPaused = false
local gameOver = false

--------------------------------------------------------------------------------
-- PLAYER
--------------------------------------------------------------------------------

local function resetPlayer(player)
    local character = player.Character
    if character then
        local hrp = character:FindFirstChild("HumanoidRootPart")
        if hrp then
            hrp.Position = Vector3.new(0, 5, 0)
        end
    end
end

local function setupPlayer(player)
    local humanoid = nil
    local character = player.Character
    if character then
        humanoid = character:FindFirstChild("Humanoid")
    end

    if humanoid then
        humanoid.WalkSpeed = 16
        humanoid.JumpPower = 50
    end

    if character then
        character:SetAttribute("ModelUrl", "asset://player.glb")
        local hrp = character:FindFirstChild("HumanoidRootPart")
        if hrp then
            hrp:SetAttribute("ModelYawOffsetDeg", 180)
            hrp.Position = Vector3.new(0, 5, 0)
            hrp:SetAttribute("Score", 0)
            hrp:SetAttribute("CoinsCollected", 0)
            hrp:SetAttribute("Alive", true)
        end
    end
    
    -- Reset everything for a new game
    gameState:SetAttribute("Score", 0)
    gameState:SetAttribute("CoinsCollected", 0)
    gameState:SetAttribute("GameTime", 0)
    gameState:SetAttribute("Wave", 1)
    gameState:SetAttribute("Alive", true)
    
    lavaY = LAVA_START_Y
    lava.Position = Vector3.new(0, lavaY, 0)
    lava:SetAttribute("LavaY", lavaY)
    lavaActive = false
    lavaStartTime = tick()
    currentWaveIndex = 1
    isPaused = false
    wavePauseTimer = 0
    gameOver = false
    gameState:SetAttribute("GameOver", false)
    WAVE_PAUSE_DURATION = 8
    
    -- Clear and respawn coins
    for i = #coins, 1, -1 do
        coins[i]:Destroy()
        table.remove(coins, i)
    end
    for i = 1, MAX_COINS do
        spawnCoin()
    end
    
    print("=== NEW GAME - LAVA RISING ===")
    print("Lava begins rising in " .. LAVA_PAUSE_AT_START .. " seconds...")
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

local function getHumanoid(player)
    local character = player.Character
    if character then
        return character:FindFirstChild("Humanoid")
    end
    return nil
end

if AgentInputService then
    AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
        local humanoid = getHumanoid(player)
        if not humanoid then return end

        if inputType == "MoveTo" and inputData and inputData.position then
            local pos = inputData.position
            humanoid:MoveTo(Vector3.new(pos[1], pos[2], pos[3]))
        elseif inputType == "Stop" then
            humanoid:CancelMoveTo()
        elseif inputType == "Jump" then
            humanoid.Jump = true
        end
    end)
end

--------------------------------------------------------------------------------
-- MAIN LOOP
--------------------------------------------------------------------------------

local gameStartTime = tick()

RunService.Heartbeat:Connect(function(dt)
    local gameTime = tick() - gameStartTime
    gameState:SetAttribute("GameTime", gameTime)
    
    -- Start lava after initial pause
    if not lavaActive and gameTime > LAVA_PAUSE_AT_START then
        lavaActive = true
        print("[LAVA] THE FLOOR IS LAVA! 🌋")
    end
    
    -- Wave system: rise, pause, rise
    -- Game Over check: lava above Spire top (13.5) + jump height (7) = 20.5
    if lavaY >= 13.5 and not gameOver then
        gameOver = true
        local finalScore = gameState:GetAttribute("Score")
        local survivalTime = gameTime
        if finalScore > gameState:GetAttribute("BestScore") then
            gameState:SetAttribute("BestScore", finalScore)
        end
        if survivalTime > gameState:GetAttribute("BestSurvivalTime") then
            gameState:SetAttribute("BestSurvivalTime", survivalTime)
        end
        gameState:SetAttribute("Alive", false)
        gameState:SetAttribute("GameOver", true)
        
        -- Destroy all remaining coins
        for i = #coins, 1, -1 do
            coins[i]:Destroy()
            table.remove(coins, i)
        end
        if dangerCoin then
            dangerCoin:Destroy()
            dangerCoin = nil
        end
        
        print("========================================")
        print("🌋 GAME OVER! 🌋")
        print("Final Score: " .. finalScore)
        print("Survival Time: " .. string.format("%.1f", survivalTime) .. "s")
        print("Best Score: " .. gameState:GetAttribute("BestScore"))
        print("========================================")
    end
    
    if gameOver then return end
    
    if lavaActive then
        if isPaused then
            wavePauseTimer = wavePauseTimer - dt
            if wavePauseTimer <= 0 then
                isPaused = false
                currentWaveIndex = currentWaveIndex + 1
                if currentWaveIndex <= #waveTargets then
                    local wave = currentWaveIndex
                    gameState:SetAttribute("Wave", wave)
                    print("[WAVE " .. wave .. "] Lava rising to " .. waveTargets[wave] .. "!")
                end
            end
        else
            -- Rise toward current wave target
            local targetY = LAVA_START_Y
            if currentWaveIndex <= #waveTargets then
                targetY = waveTargets[currentWaveIndex]
            else
                targetY = lavaY + LAVA_RISE_SPEED * dt * 2  -- accelerating endgame
            end
            
            if lavaY < targetY then
                lavaY = lavaY + LAVA_RISE_SPEED * dt
                if lavaY >= targetY and currentWaveIndex <= #waveTargets then
                    lavaY = targetY
                    isPaused = true
                    wavePauseTimer = WAVE_PAUSE_DURATION
                    print("[WAVE " .. currentWaveIndex .. "] Lava paused at Y=" .. string.format("%.1f", lavaY) .. " for " .. WAVE_PAUSE_DURATION .. "s")
                    
                    -- Bonus: speed up lava as waves progress
                    if currentWaveIndex > 5 then
                        WAVE_PAUSE_DURATION = math.max(3, WAVE_PAUSE_DURATION - 1)
                    end
                end
            end
            
            lava.Position = Vector3.new(0, lavaY, 0)
            lava:SetAttribute("LavaY", lavaY)
            gameState:SetAttribute("LavaY", lavaY)
        end
    end
    
    -- Purge drowned coins and refill
    purgeDrownedCoins()
    
    -- Danger coin system
    if lavaActive and not gameOver and not dangerCoin and (tick() - lastDangerSpawn) > DANGER_COOLDOWN then
        spawnDangerCoin()
    end
    
    -- Coin bob animation
    for _, coin in ipairs(coins) do
        local t = tick() - (coin:GetAttribute("SpawnTick") or 0)
        local bobY = math.sin(t * 2) * 0.3
        coin.Position = Vector3.new(coin.Position.X, coin.Position.Y + bobY * dt, coin.Position.Z)
    end
    
    -- Check coin collection and lava damage for all players
    for _, player in ipairs(Players:GetPlayers()) do
        local character = player.Character
        if character then
            local hrp = character:FindFirstChild("HumanoidRootPart")
            if hrp then
                local playerPos = hrp.Position
                local playerFeetY = playerPos.Y - 2.55  -- approximate feet position
                
                -- Lava check: if feet are below lava surface
                if lavaActive and playerFeetY < lavaY then
                    local now = tick()
                    if now - lastDamageTick > LAVA_DAMAGE_INTERVAL then
                        lastDamageTick = now
                        
                        -- Save best records before death
                        local score = gameState:GetAttribute("Score")
                        local wave = gameState:GetAttribute("Wave")
                        local survivalTime = gameTime
                        
                        if score > gameState:GetAttribute("BestScore") then
                            gameState:SetAttribute("BestScore", score)
                        end
                        if wave > gameState:GetAttribute("BestWave") then
                            gameState:SetAttribute("BestWave", wave)
                        end
                        if survivalTime > gameState:GetAttribute("BestSurvivalTime") then
                            gameState:SetAttribute("BestSurvivalTime", survivalTime)
                        end
                        
                        print("[LAVA] ☠️ BURNED! Score: " .. score .. " | Wave: " .. wave .. " | Time: " .. string.format("%.1f", survivalTime) .. "s")
                        print("[LAVA] Best Score: " .. gameState:GetAttribute("BestScore") .. " | Best Wave: " .. gameState:GetAttribute("BestWave"))
                        
                        gameState:SetAttribute("Alive", false)
                        hrp:SetAttribute("Alive", false)
                        
                        -- Teleport player back to safety (above lava on nearest safe structure)
                        local safeY = lavaY + 5
                        -- Find the highest safe structure they can stand on
                        for _, m in ipairs(mesaData) do
                            if m.topY > lavaY and m.name ~= "Ground" then
                                hrp.Position = Vector3.new(m.centerX, m.topY + 3, m.centerZ)
                                break
                            end
                        end
                        
                        -- Reset score but keep playing (roguelike feel)
                        gameState:SetAttribute("Score", 0)
                        gameState:SetAttribute("CoinsCollected", 0)
                        gameState:SetAttribute("Alive", true)
                        hrp:SetAttribute("Score", 0)
                        hrp:SetAttribute("CoinsCollected", 0)
                        hrp:SetAttribute("Alive", true)
                    end
                end
                
                -- Coin collection
                for i = #coins, 1, -1 do
                    local coin = coins[i]
                    local dist = (coin.Position - playerPos).Magnitude
                    if dist < COIN_COLLECT_DIST then
                        collectCoin(i, player)
                    end
                end
                
                -- Danger coin collection
                checkDangerCoin(playerPos, player)
            end
        end
    end
    
    -- Respawn coins if below max
    while #coins < MAX_COINS do
        spawnCoin()
    end
end)

--------------------------------------------------------------------------------
-- INITIALIZATION
--------------------------------------------------------------------------------

Players.PlayerAdded:Connect(setupPlayer)
Players.PlayerRemoving:Connect(function() end)

for _, player in ipairs(Players:GetPlayers()) do
    setupPlayer(player)
end

print("=== 🌋 LAVA RISING 🌋 ===")
print("Collect coins before the lava swallows them!")
print("Higher = safer = more points!")
print("Lava rises in " .. LAVA_PAUSE_AT_START .. " seconds...")
