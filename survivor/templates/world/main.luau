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
gameState:SetAttribute("can_reveal_votes", false)
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
    gameState:SetAttribute("can_reveal_votes", false)
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

local activeSpeechStreams = {}  -- stream_id -> playerName

local function clearSpeakerByName(name)
    if not name or name == "" then
        return
    end
    for _, p in ipairs(Players:GetPlayers()) do
        if p.Name == name then
            p:SetAttribute("IsSpeaking", false)
            break
        end
    end
    if gameState:GetAttribute("current_speaker") == name then
        gameState:SetAttribute("current_speaker", "")
        gameState:SetAttribute("speaker_claimed_at", 0)
    end
end

local function hasActiveStreamForPlayer(name)
    for _, streamSpeaker in pairs(activeSpeechStreams) do
        if streamSpeaker == name then
            return true
        end
    end
    return false
end

local function releaseStream(streamId)
    local speakerName = activeSpeechStreams[streamId]
    if not speakerName then
        return false
    end
    activeSpeechStreams[streamId] = nil
    -- If this speaker still has another active stream (e.g. multiple <speak> tags),
    -- keep the speaking lock until the final stream finishes.
    if not hasActiveStreamForPlayer(speakerName) then
        clearSpeakerByName(speakerName)
    end
    return true
end

AgentInputService.InputReceived:Connect(function(player, inputType, inputData)
    if inputType == "Vote" and inputData and inputData.target then
        if player.Name == "host" then return end
        if votes[player.Name] then return end  -- already voted
        votes[player.Name] = inputData.target
        player:SetAttribute("HasVoted", true)
        local received = gameState:GetAttribute("votes_received") + 1
        gameState:SetAttribute("votes_received", received)
        if received >= gameState:GetAttribute("total_voters") then
            -- Host decides when to reveal. Keep votes private until RevealVotes.
            gameState:SetAttribute("can_reveal_votes", true)
            gameState:SetAttribute("phase", "awaiting_reveal")
        end
    elseif inputType == "UseIdol" and inputData and inputData.target then
        idolPlays[player.Name] = inputData.target
    elseif inputType == "RevealVotes" then
        if player.Name ~= "host" then
            warn("[RevealVotes] Rejected: only host can reveal votes")
            return
        end
        if gameState:GetAttribute("votes_received") < gameState:GetAttribute("total_voters") then
            warn("[RevealVotes] Rejected: not all votes are in yet")
            return
        end
        tallyVotes()
    elseif inputType == "PlaySpeech" then
        if not inputData or not inputData.stream_id then
            warn("[PlaySpeech] Missing stream_id from " .. player.Name)
            return
        end

        -- Reject if someone else is speaking
        local speaker = gameState:GetAttribute("current_speaker")
        if speaker ~= "" and speaker ~= nil and speaker ~= player.Name then
            warn("[PlaySpeech] Rejected: " .. player.Name .. " tried to speak but " .. speaker .. " is speaking")
            return
        end

        -- Claim the turn
        gameState:SetAttribute("current_speaker", player.Name)
        gameState:SetAttribute("speaker_claimed_at", tick())
        player:SetAttribute("IsSpeaking", true)

        activeSpeechStreams[inputData.stream_id] = player.Name
    elseif inputType == "SpeechFinished" or inputType == "AudioEnded" then
        if not inputData or not inputData.stream_id then
            warn("[" .. inputType .. "] Missing stream_id")
            return
        end
        if not activeSpeechStreams[inputData.stream_id] then
            warn("[" .. inputType .. "] No active stream for stream_id: " .. tostring(inputData.stream_id))
            return
        end
        -- Optional reason can help with debugging turn ownership behavior.
        if inputData.reason and inputData.reason ~= "playback_done" then
            warn("[" .. inputType .. "] stream_id=" .. tostring(inputData.stream_id) .. " reason=" .. tostring(inputData.reason))
        end
        releaseStream(inputData.stream_id)
    end
end)

--------------------------------------------------------------------------------
-- MAIN LOOP
--------------------------------------------------------------------------------

RunService.Heartbeat:Connect(function(dt)
    -- Speaking lock is released only by explicit SpeechFinished/AudioEnded events.
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
