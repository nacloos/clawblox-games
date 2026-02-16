-- Survivor — Tribal Council voting server

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local AgentInputService = game:GetService("AgentInputService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

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
gameState:SetAttribute("last_speech_at_ms", 0)
gameState:SetAttribute("silence_ms", 0)
gameState:SetAttribute("is_globally_silent", false)
gameState:SetAttribute("silence_epoch", 0)
gameState:SetAttribute("silence_threshold_ms", 8000)
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

local speechBus = Instance.new("RemoteEvent")
speechBus.Name = "SpeechBus"
speechBus.Parent = ReplicatedStorage

local activeSpeechStreams = {}  -- stream_id -> { speaker = name, release_at_ms = number? }
local SILENCE_THRESHOLD_MS = 8000
local DEFAULT_SAMPLE_RATE_HZ = 24000
local DEFAULT_CHANNELS = 1
local DEFAULT_BYTES_PER_SAMPLE = 2
local DEFAULT_PLAYBACK_SPEED = 1.0

local function nowMs()
    return math.floor(tick() * 1000)
end

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
    for _, streamState in pairs(activeSpeechStreams) do
        if streamState and streamState.speaker == name then
            return true
        end
    end
    return false
end

local function releaseStream(streamId, reason)
    local streamState = activeSpeechStreams[streamId]
    if not streamState then
        return false
    end
    local speakerName = streamState.speaker
    activeSpeechStreams[streamId] = nil

    -- If this speaker still has another active stream (e.g. multiple <speak> tags),
    -- keep the speaking lock until the final stream finishes.
    if not hasActiveStreamForPlayer(speakerName) then
        clearSpeakerByName(speakerName)
    end
    local now = nowMs()
    gameState:SetAttribute("last_speech_at_ms", now)
    gameState:SetAttribute("silence_ms", 0)
    gameState:SetAttribute("is_globally_silent", false)
    speechBus:FireAllClients({
        op = "Released",
        speaker = speakerName,
        stream_id = streamId,
        reason = reason or "released",
        at_ms = now,
    })
    return true
end

local function parsePositiveNumber(value, fallback)
    if type(value) ~= "number" then
        return fallback
    end
    if value <= 0 then
        return fallback
    end
    return value
end

local function parsePlaybackDurationMs(payload)
    local totalBytes = parsePositiveNumber(payload.total_audio_bytes, 0)
    local sampleRate = parsePositiveNumber(payload.sample_rate_hz, DEFAULT_SAMPLE_RATE_HZ)
    local channels = parsePositiveNumber(payload.channels, DEFAULT_CHANNELS)
    local bytesPerSample = parsePositiveNumber(payload.bytes_per_sample, DEFAULT_BYTES_PER_SAMPLE)
    local playbackSpeed = parsePositiveNumber(payload.playback_speed, DEFAULT_PLAYBACK_SPEED)
    if totalBytes <= 0 then
        return 0
    end
    local bytesPerSecond = sampleRate * channels * bytesPerSample
    if bytesPerSecond <= 0 then
        return 0
    end
    local durationMs = math.floor((totalBytes / bytesPerSecond) / playbackSpeed * 1000)
    if durationMs < 0 then
        return 0
    end
    return durationMs
end

local function rejectSpeech(player, streamId, reason)
    speechBus:FireClient(player, {
        op = "Rejected",
        stream_id = streamId or "",
        reason = reason or "rejected",
        at_ms = nowMs(),
    })
end

speechBus.OnServerEvent:Connect(function(player, payload)
    if type(payload) ~= "table" then
        return
    end
    local op = payload.op
    local streamId = payload.stream_id
    if type(op) ~= "string" then
        return
    end
    if type(streamId) ~= "string" or streamId == "" then
        rejectSpeech(player, streamId, "missing_stream_id")
        return
    end

    if op == "Claim" then
        local speaker = gameState:GetAttribute("current_speaker")
        if speaker ~= "" and speaker ~= nil and speaker ~= player.Name then
            rejectSpeech(player, streamId, "speaker_locked")
            return
        end
        gameState:SetAttribute("current_speaker", player.Name)
        gameState:SetAttribute("speaker_claimed_at", tick())
        gameState:SetAttribute("is_globally_silent", false)
        gameState:SetAttribute("silence_ms", 0)
        player:SetAttribute("IsSpeaking", true)
        activeSpeechStreams[streamId] = {
            speaker = player.Name,
            release_at_ms = nil,
        }
        speechBus:FireAllClients({
            op = "Claimed",
            speaker = player.Name,
            stream_id = streamId,
            at_ms = nowMs(),
        })
        return
    end

    local streamState = activeSpeechStreams[streamId]
    if not streamState then
        rejectSpeech(player, streamId, "unknown_stream")
        return
    end
    if streamState.speaker ~= player.Name then
        rejectSpeech(player, streamId, "not_owner")
        return
    end

    if op == "Finalize" then
        local durationMs = parsePlaybackDurationMs(payload)
        local releaseAtMs = nowMs() + durationMs
        streamState.release_at_ms = releaseAtMs
        activeSpeechStreams[streamId] = streamState
        local speechText = ""
        if type(payload.speech_text) == "string" then
            speechText = payload.speech_text
        end
        if speechText ~= "" then
            speechBus:FireAllClients({
                op = "SpeechText",
                speaker = player.Name,
                stream_id = streamId,
                text = speechText,
                at_ms = nowMs(),
            })
        end
        if durationMs <= 0 then
            releaseStream(streamId, "natural_end")
        end
        return
    end

    if op == "Cancel" then
        releaseStream(streamId, "cancelled")
    end
end)

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
    end
end)

--------------------------------------------------------------------------------
-- MAIN LOOP
--------------------------------------------------------------------------------

RunService.Heartbeat:Connect(function(dt)
    local now = nowMs()
    for streamId, streamState in pairs(activeSpeechStreams) do
        if streamState and streamState.release_at_ms and now >= streamState.release_at_ms then
            releaseStream(streamId, "natural_end")
        end
    end

    local currentSpeaker = gameState:GetAttribute("current_speaker")
    local threshold = gameState:GetAttribute("silence_threshold_ms") or SILENCE_THRESHOLD_MS
    local lastSpeechAt = gameState:GetAttribute("last_speech_at_ms") or now
    local silenceMs = 0
    if currentSpeaker == "" or currentSpeaker == nil then
        silenceMs = math.max(0, now - lastSpeechAt)
    end
    gameState:SetAttribute("silence_ms", silenceMs)

    local isSilent = (currentSpeaker == "" or currentSpeaker == nil) and silenceMs >= threshold
    local wasSilent = gameState:GetAttribute("is_globally_silent") == true
    if isSilent ~= wasSilent then
        gameState:SetAttribute("is_globally_silent", isSilent)
        if isSilent then
            local epoch = gameState:GetAttribute("silence_epoch") or 0
            gameState:SetAttribute("silence_epoch", epoch + 1)
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
gameState:SetAttribute("last_speech_at_ms", nowMs())

print("=== Survivor — Tribal Council ===")
