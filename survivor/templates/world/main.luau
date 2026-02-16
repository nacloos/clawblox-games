-- Survivor — Tribal Council voting server

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

--------------------------------------------------------------------------------
-- GAME STATE
--------------------------------------------------------------------------------

local gameState = Instance.new("Folder")
gameState.Name = "GameState"
gameState:SetAttribute("phase", "voting")
gameState:SetAttribute("votes_received", 0)
gameState:SetAttribute("total_voters", 0)
gameState:SetAttribute("result", "")
gameState:SetAttribute("current_speaker", "")
gameState:SetAttribute("speaker_claimed_at", 0)
gameState.Parent = Workspace

local votes = {}       -- private: { [playerName] = targetName }
local idolPlays = {}   -- private: { [playerName] = targetName }

local function countVoters()
    local n = 0
    for _, p in ipairs(Players:GetPlayers()) do
        if p.Name ~= "host" then n = n + 1 end
    end
    gameState:SetAttribute("total_voters", n)
end

local function tallyVotes()
    local counts = {}
    for voter, target in pairs(votes) do
        local dominated = false
        for _, idolTarget in pairs(idolPlays) do
            if idolTarget == target then dominated = true; break end
        end
        if not dominated then
            counts[target] = (counts[target] or 0) + 1
        end
    end

    local maxName, maxCount = "", 0
    for name, count in pairs(counts) do
        if count > maxCount then maxName, maxCount = name, count end
    end

    local parts = {}
    for voter, target in pairs(votes) do
        table.insert(parts, voter .. ":" .. target)
    end
    gameState:SetAttribute("result",
        "eliminated:" .. maxName .. "|" .. table.concat(parts, ","))
    gameState:SetAttribute("phase", "result")
end

--------------------------------------------------------------------------------
-- PLAYER
--------------------------------------------------------------------------------

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
        end
    end

    countVoters()
end

local function cleanupPlayer(player)
    countVoters()
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
    if inputType == "Vote" and inputData and inputData.target then
        if player.Name == "host" then return end
        if votes[player.Name] then return end  -- already voted
        votes[player.Name] = inputData.target
        player:SetAttribute("HasVoted", true)
        local received = gameState:GetAttribute("votes_received") + 1
        gameState:SetAttribute("votes_received", received)
        if received >= gameState:GetAttribute("total_voters") then
            tallyVotes()
        end
    elseif inputType == "UseIdol" and inputData and inputData.target then
        idolPlays[player.Name] = inputData.target
    elseif inputType == "ClaimSpeaking" then
        local speaker = gameState:GetAttribute("current_speaker")
        if speaker == "" or speaker == nil then
            gameState:SetAttribute("current_speaker", player.Name)
            gameState:SetAttribute("speaker_claimed_at", tick())
            player:SetAttribute("IsSpeaking", true)
        end
    elseif inputType == "ReleaseSpeaking" then
        if gameState:GetAttribute("current_speaker") == player.Name then
            gameState:SetAttribute("current_speaker", "")
            gameState:SetAttribute("speaker_claimed_at", 0)
            player:SetAttribute("IsSpeaking", false)
        end
    end
end)

--------------------------------------------------------------------------------
-- MAIN LOOP
--------------------------------------------------------------------------------

RunService.Heartbeat:Connect(function(dt)
    -- Auto-release speaking lock after 15s (safety valve for crashed agents)
    local speaker = gameState:GetAttribute("current_speaker")
    if speaker and speaker ~= "" then
        local claimedAt = gameState:GetAttribute("speaker_claimed_at")
        if claimedAt > 0 and tick() - claimedAt > 15 then
            for _, p in ipairs(Players:GetPlayers()) do
                if p.Name == speaker then
                    p:SetAttribute("IsSpeaking", false)
                    break
                end
            end
            gameState:SetAttribute("current_speaker", "")
            gameState:SetAttribute("speaker_claimed_at", 0)
        end
    end
end)

--------------------------------------------------------------------------------
-- INITIALIZATION
--------------------------------------------------------------------------------

Players.PlayerAdded:Connect(setupPlayer)
Players.PlayerRemoving:Connect(cleanupPlayer)

for _, player in ipairs(Players:GetPlayers()) do
    setupPlayer(player)
end

countVoters()

print("=== Survivor — Tribal Council ===")
