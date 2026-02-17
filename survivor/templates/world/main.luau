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
gameState:SetAttribute("pending_speakers", 0)
gameState:SetAttribute("current_turn_stream_id", "")
gameState:SetAttribute("current_turn_lease_id", "")
gameState:SetAttribute("current_lease_expires_at_ms", 0)
gameState.Parent = Workspace

local votes = {}       -- private: { [playerName] = targetName }
local idolPlays = {}   -- private: { [playerName] = targetName }
local allVotesInCueSent = false

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
    player:SetAttribute("IsSpeaking", false)
    player:SetAttribute("SpeechStreamId", "")
    player:SetAttribute("SpeechLeaseId", "")

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
    player:SetAttribute("IsSpeaking", false)
    player:SetAttribute("SpeechStreamId", "")
    player:SetAttribute("SpeechLeaseId", "")
    countVoters()
end

--------------------------------------------------------------------------------
-- INPUT HANDLING
--------------------------------------------------------------------------------

local speechBus = Instance.new("RemoteEvent")
speechBus.Name = "SpeechBus"
speechBus.Parent = ReplicatedStorage

local activeTurn = nil          -- { player_name, stream_id, lease_id, lease_expires_at_ms, finalized, release_at_ms, last_heartbeat_ms, last_progress_seq, last_progress_at_ms, final_speech_text }
local pendingByPlayer = {}      -- player_name -> { stream_id = string, requested_at_ms = number }
local SILENCE_THRESHOLD_MS = 8000
local DEFAULT_SAMPLE_RATE_HZ = 24000
local DEFAULT_CHANNELS = 1
local DEFAULT_BYTES_PER_SAMPLE = 2
local DEFAULT_PLAYBACK_SPEED = 1.0
local TURN_LEASE_MS = 7000

local function nowMs()
    return DateTime.now().UnixTimestampMillis
end

local function simMs()
    return math.floor(time() * 1000)
end

local function speechLog(message)
    print(string.format("[SpeechBus][wall_ms=%d][sim_ms=%d] %s", nowMs(), simMs(), tostring(message)))
end

local function emitSpeechText(speakerName, text, releaseReason, targetName)
    if type(text) ~= "string" or text == "" then
        return
    end
    speechBus:FireAllClients({
        op = "SpeechText",
        speaker = tostring(speakerName or ""),
        stream_id = "",
        lease_id = "",
        text = text,
        release_reason = tostring(releaseReason or "system"),
        target = targetName or "*",
        at_ms = nowMs(),
    })
end

local function findPlayerByName(name)
    for _, p in ipairs(Players:GetPlayers()) do
        if p.Name == name then
            return p
        end
    end
    return nil
end

local function clearSpeakerByName(name)
    if not name or name == "" then
        return
    end
    local p = findPlayerByName(name)
    if p then
        p:SetAttribute("IsSpeaking", false)
        p:SetAttribute("SpeechStreamId", "")
        p:SetAttribute("SpeechLeaseId", "")
    end
    if gameState:GetAttribute("current_speaker") == name then
        gameState:SetAttribute("current_speaker", "")
        gameState:SetAttribute("speaker_claimed_at", 0)
    end
end

local function queueSize()
    local count = 0
    for _ in pairs(pendingByPlayer) do
        count += 1
    end
    return count
end

local function isClaimStale(claim)
    if type(claim) ~= "table" then
        return true
    end
    local requestedAt = tonumber(claim.requested_at_ms or 0) or 0
    local lastSpeechAt = tonumber(gameState:GetAttribute("last_speech_at_ms") or 0) or 0
    -- Any queued claim created before (or exactly at) the most recent committed speech
    -- is stale for the next turn and should not be granted.
    return requestedAt > 0 and requestedAt <= lastSpeechAt
end

local function setQueueAttrs()
    gameState:SetAttribute("pending_speakers", queueSize())
end

local function dropStaleQueuedClaims(cutoffMs)
    local cutoff = tonumber(cutoffMs or 0) or 0
    if cutoff <= 0 then
        return 0
    end
    local dropped = 0
    for playerName, claim in pairs(pendingByPlayer) do
        if type(claim) == "table" and isClaimStale(claim) then
            speechLog(string.format(
                "drop_stale_claim speaker=%s stream=%s requested_at_ms=%d last_speech_at_ms=%d",
                tostring(playerName),
                tostring(claim.stream_id or ""),
                tonumber(claim.requested_at_ms or 0) or 0,
                cutoff
            ))
            pendingByPlayer[playerName] = nil
            dropped += 1
        end
    end
    if dropped > 0 then
        setQueueAttrs()
    end
    return dropped
end

local function removeQueuedClaimForPlayer(name)
    if not name or name == "" then
        return nil
    end
    local claim = pendingByPlayer[name]
    pendingByPlayer[name] = nil
    if not claim then
        setQueueAttrs()
        return nil
    end
    setQueueAttrs()
    return claim.stream_id
end

local function updateTurnAttrs()
    if activeTurn then
        gameState:SetAttribute("current_turn_stream_id", activeTurn.stream_id)
        gameState:SetAttribute("current_turn_lease_id", activeTurn.lease_id)
        gameState:SetAttribute("current_lease_expires_at_ms", activeTurn.lease_expires_at_ms or 0)
    else
        gameState:SetAttribute("current_turn_stream_id", "")
        gameState:SetAttribute("current_turn_lease_id", "")
        gameState:SetAttribute("current_lease_expires_at_ms", 0)
    end
end

local function makeLeaseId(playerName, streamId)
    return playerName .. "_" .. tostring(nowMs()) .. "_" .. tostring(math.random(1000, 9999)) .. "_" .. streamId
end

local function grantSpeech(player, streamId, fromQueue)
    if not player or not streamId or streamId == "" then
        return false, nil
    end
    if activeTurn ~= nil then
        return false, nil
    end

    local leaseId = makeLeaseId(player.Name, streamId)
    local now = nowMs()
    activeTurn = {
        player_name = player.Name,
        stream_id = streamId,
        lease_id = leaseId,
        lease_expires_at_ms = now + TURN_LEASE_MS,
        finalized = false,
        finalized_at_ms = nil,
        release_at_ms = nil,
        last_heartbeat_ms = now,
        last_progress_seq = 0,
        last_progress_at_ms = now,
        next_wait_log_ms = now,
        final_speech_text = "",
    }

    gameState:SetAttribute("current_speaker", player.Name)
    gameState:SetAttribute("speaker_claimed_at", nowMs())
    gameState:SetAttribute("is_globally_silent", false)
    gameState:SetAttribute("silence_ms", 0)
    player:SetAttribute("IsSpeaking", true)
    player:SetAttribute("SpeechStreamId", streamId)
    player:SetAttribute("SpeechLeaseId", leaseId)
    updateTurnAttrs()

    speechBus:FireClient(player, {
        op = "Granted",
        speaker = player.Name,
        stream_id = streamId,
        lease_id = leaseId,
        lease_expires_at_ms = activeTurn.lease_expires_at_ms,
        from_queue = fromQueue == true,
        at_ms = now,
    })
    speechBus:FireAllClients({
        op = "Claimed",
        speaker = player.Name,
        stream_id = streamId,
        lease_id = leaseId,
        lease_expires_at_ms = activeTurn.lease_expires_at_ms,
        from_queue = fromQueue == true,
        at_ms = now,
    })
    speechLog(string.format(
        "granted speaker=%s stream=%s lease=%s from_queue=%s queue_len=%d lease_expires_at_ms=%d",
        player.Name,
        streamId,
        leaseId,
        tostring(fromQueue == true),
        queueSize(),
        activeTurn.lease_expires_at_ms or 0
    ))
    return true, leaseId
end

local function grantNextQueuedSpeaker()
    if activeTurn ~= nil then
        return false
    end
    while queueSize() > 0 do
        local chosenName = nil
        local chosenClaim = nil
        for playerName, claim in pairs(pendingByPlayer) do
            if type(claim) == "table"
                and type(claim.stream_id) == "string"
                and claim.stream_id ~= ""
                and type(claim.requested_at_ms) == "number" then
                if chosenClaim == nil or claim.requested_at_ms > chosenClaim.requested_at_ms then
                    chosenName = playerName
                    chosenClaim = claim
                end
            end
        end

        if not chosenName or not chosenClaim then
            if queueSize() > 0 then
                pendingByPlayer = {}
                setQueueAttrs()
            end
            return false
        end

        pendingByPlayer[chosenName] = nil
        setQueueAttrs()
        local player = findPlayerByName(chosenName)
        if player then
            if grantSpeech(player, chosenClaim.stream_id, true) then
                return true
            end
        end
    end
    return false
end

local function releaseActiveTurn(reason)
    if not activeTurn then
        return false
    end
    local turn = activeTurn
    activeTurn = nil
    clearSpeakerByName(turn.player_name)
    updateTurnAttrs()
    local now = nowMs()
    gameState:SetAttribute("last_speech_at_ms", now)
    gameState:SetAttribute("silence_ms", 0)
    gameState:SetAttribute("is_globally_silent", false)
    -- Important ordering: drop stale queued claims before broadcasting committed
    -- speech so only fresh post-message claims compete for the next turn.
    dropStaleQueuedClaims(now)
    local finalSpeechText = ""
    if turn.finalized and type(turn.final_speech_text) == "string" then
        finalSpeechText = turn.final_speech_text
    end
    if finalSpeechText ~= "" then
        speechBus:FireAllClients({
            op = "SpeechText",
            speaker = turn.player_name,
            stream_id = turn.stream_id,
            lease_id = turn.lease_id,
            text = finalSpeechText,
            release_reason = reason or "released",
            target = "*",
            at_ms = now,
        })
    end
    speechBus:FireAllClients({
        op = "Released",
        speaker = turn.player_name,
        stream_id = turn.stream_id,
        lease_id = turn.lease_id,
        reason = reason or "released",
        at_ms = now,
    })
    local heldMs = 0
    if turn and turn.finalized_at_ms and turn.finalized_at_ms > 0 then
        heldMs = math.max(0, now - turn.finalized_at_ms)
    end
    speechLog(string.format(
        "released speaker=%s stream=%s lease=%s reason=%s held_after_finalize_ms=%d queue_len=%d",
        turn.player_name or "",
        turn.stream_id or "",
        turn.lease_id or "",
        tostring(reason or "released"),
        heldMs,
        queueSize()
    ))
    return true
end

local function enqueueClaim(player, streamId)
    local now = nowMs()
    local existingClaim = pendingByPlayer[player.Name]
    if existingClaim and existingClaim.stream_id == streamId then
        speechBus:FireClient(player, {
            op = "Queued",
            stream_id = streamId,
            position = queueSize(),
            at_ms = now,
        })
        return
    end
    pendingByPlayer[player.Name] = {
        stream_id = streamId,
        requested_at_ms = now,
    }
    setQueueAttrs()
    speechBus:FireClient(player, {
        op = "Queued",
        stream_id = streamId,
        position = queueSize(),
        at_ms = now,
    })
    speechLog(string.format(
        "queued_latest speaker=%s stream=%s active_speaker=%s pending_count=%d",
        player.Name,
        streamId,
        tostring(gameState:GetAttribute("current_speaker") or ""),
        queueSize()
    ))
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

local function validateActiveTurn(player, streamId, leaseId)
    if not activeTurn then
        rejectSpeech(player, streamId, "no_active_turn")
        return nil
    end
    if activeTurn.player_name ~= player.Name then
        rejectSpeech(player, streamId, "not_owner")
        return nil
    end
    if activeTurn.stream_id ~= streamId then
        rejectSpeech(player, streamId, "stream_mismatch")
        return nil
    end
    if type(leaseId) ~= "string" or leaseId == "" or activeTurn.lease_id ~= leaseId then
        rejectSpeech(player, streamId, "lease_mismatch")
        return nil
    end
    return activeTurn
end

speechBus.OnServerEvent:Connect(function(player, payload)
    if type(payload) ~= "table" then
        return
    end
    local op = payload.op
    local streamId = payload.stream_id
    local leaseId = payload.lease_id
    if type(op) ~= "string" then
        return
    end
    if type(streamId) ~= "string" or streamId == "" then
        rejectSpeech(player, streamId, "missing_stream_id")
        return
    end

    if op == "Claim" then
        if activeTurn and activeTurn.player_name == player.Name and activeTurn.stream_id == streamId then
            speechBus:FireClient(player, {
                op = "Granted",
                speaker = player.Name,
                stream_id = streamId,
                lease_id = activeTurn.lease_id,
                lease_expires_at_ms = activeTurn.lease_expires_at_ms,
                from_queue = false,
                at_ms = nowMs(),
            })
            return
        end
        if activeTurn == nil then
            removeQueuedClaimForPlayer(player.Name)
            grantSpeech(player, streamId, false)
            return
        end
        enqueueClaim(player, streamId)
        speechLog(string.format(
            "claim_deferred speaker=%s stream=%s active_speaker=%s active_stream=%s queue_len=%d",
            player.Name,
            streamId,
            tostring(activeTurn and activeTurn.player_name or ""),
            tostring(activeTurn and activeTurn.stream_id or ""),
            queueSize()
        ))
        return
    end

    if op == "Heartbeat" then
        local turn = validateActiveTurn(player, streamId, leaseId)
        if not turn then
            return
        end
        local now = nowMs()
        turn.lease_expires_at_ms = now + TURN_LEASE_MS
        turn.last_heartbeat_ms = now
        local progressSeq = parsePositiveNumber(payload.progress_seq, turn.last_progress_seq or 0)
        if progressSeq > (turn.last_progress_seq or 0) then
            turn.last_progress_seq = progressSeq
            turn.last_progress_at_ms = now
        end
        updateTurnAttrs()
        speechBus:FireClient(player, {
            op = "HeartbeatAck",
            stream_id = streamId,
            lease_id = turn.lease_id,
            lease_expires_at_ms = turn.lease_expires_at_ms,
            at_ms = now,
        })
        return
    end

    if op == "Progress" then
        local turn = validateActiveTurn(player, streamId, leaseId)
        if not turn then
            return
        end
        local now = nowMs()
        turn.lease_expires_at_ms = now + TURN_LEASE_MS
        turn.last_heartbeat_ms = now

        local progressSeq = parsePositiveNumber(payload.progress_seq, turn.last_progress_seq or 0)
        if progressSeq > (turn.last_progress_seq or 0) then
            turn.last_progress_seq = progressSeq
            turn.last_progress_at_ms = now
        end
        updateTurnAttrs()
        speechBus:FireClient(player, {
            op = "ProgressAck",
            stream_id = streamId,
            lease_id = turn.lease_id,
            progress_seq = turn.last_progress_seq or 0,
            lease_expires_at_ms = turn.lease_expires_at_ms,
            at_ms = now,
        })
        return
    end

    if op == "Finalize" then
        local turn = validateActiveTurn(player, streamId, leaseId)
        if not turn then
            return
        end
        if turn.finalized then
            return
        end
        local reportedDurationMs = parsePlaybackDurationMs(payload)
        local now = nowMs()
        turn.finalized = true
        turn.finalized_at_ms = now
        turn.release_at_ms = now
        turn.lease_expires_at_ms = now + TURN_LEASE_MS
        turn.next_wait_log_ms = now
        updateTurnAttrs()
        speechLog(string.format(
            "finalize speaker=%s stream=%s lease=%s reported_duration_ms=%d release_at_ms=%d now_ms=%d last_progress_seq=%d",
            player.Name,
            streamId,
            tostring(turn.lease_id),
            reportedDurationMs,
            turn.release_at_ms or 0,
            now,
            tonumber(turn.last_progress_seq or 0) or 0
        ))

        local speechText = ""
        if type(payload.speech_text) == "string" then
            speechText = payload.speech_text
        end
        turn.final_speech_text = speechText
        if releaseActiveTurn("finalize") then
            grantNextQueuedSpeaker()
            return
        end
        return
    end

    if op == "Cancel" then
        local removed = removeQueuedClaimForPlayer(player.Name)
        if removed and removed == streamId then
            speechBus:FireClient(player, {
                op = "Cancelled",
                stream_id = streamId,
                at_ms = nowMs(),
            })
            return
        end
        if activeTurn and activeTurn.player_name == player.Name and activeTurn.stream_id == streamId then
            if type(leaseId) == "string" and leaseId ~= "" and leaseId ~= activeTurn.lease_id then
                rejectSpeech(player, streamId, "lease_mismatch")
                return
            end
            releaseActiveTurn("cancelled")
            grantNextQueuedSpeaker()
            return
        end
        rejectSpeech(player, streamId, "unknown_stream")
        return
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
            if not allVotesInCueSent then
                allVotesInCueSent = true
                emitSpeechText("producer", "All votes are in. Host, reveal when ready.", "system_cue", "host")
                speechLog(string.format(
                    "system_cue target=host kind=all_votes_in votes_received=%d total_voters=%d",
                    received,
                    gameState:GetAttribute("total_voters") or 0
                ))
            end
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
    elseif inputType == "SpeechFinished" and inputData then
        local streamId = tostring(inputData.stream_id or "")
        local reason = tostring(inputData.reason or "unknown")
        local speaker = tostring(inputData.speaker or player.Name or "")
        local speechText = tostring(inputData.speech_text or "")
        speechLog(string.format(
            "playback_finished speaker=%s stream=%s reason=%s speech_text_len=%d",
            speaker,
            streamId,
            reason,
            string.len(speechText)
        ))
    end
end)

--------------------------------------------------------------------------------
-- MAIN LOOP
--------------------------------------------------------------------------------

RunService.Heartbeat:Connect(function(dt)
    local now = nowMs()
    if activeTurn then
        if activeTurn.finalized then
            if activeTurn.release_at_ms and now < activeTurn.release_at_ms and now >= (activeTurn.next_wait_log_ms or 0) then
                local waitRemaining = math.max(0, activeTurn.release_at_ms - now)
                speechLog(string.format(
                    "waiting_release speaker=%s stream=%s wait_remaining_ms=%d",
                    tostring(activeTurn.player_name or ""),
                    tostring(activeTurn.stream_id or ""),
                    waitRemaining
                ))
                activeTurn.next_wait_log_ms = now + 1000
            end
            if activeTurn.release_at_ms and now >= activeTurn.release_at_ms then
                releaseActiveTurn("natural_end")
                grantNextQueuedSpeaker()
            end
        else
            if now >= (activeTurn.lease_expires_at_ms or 0) then
                releaseActiveTurn("lease_expired")
                grantNextQueuedSpeaker()
            end
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
            local nextEpoch = epoch + 1
            gameState:SetAttribute("silence_epoch", nextEpoch)
            speechBus:FireAllClients({
                op = "GlobalSilence",
                epoch = nextEpoch,
                silence_ms = silenceMs,
                threshold_ms = threshold,
                last_speech_at_ms = lastSpeechAt,
                at_ms = now,
            })
            speechLog(string.format(
                "global_silence true epoch=%d silence_ms=%d threshold_ms=%d last_speech_at_ms=%d",
                nextEpoch,
                silenceMs,
                threshold,
                lastSpeechAt
            ))
        else
            speechLog(string.format(
                "global_silence false silence_ms=%d threshold_ms=%d current_speaker=%s",
                silenceMs,
                threshold,
                tostring(currentSpeaker or "")
            ))
        end
    end

    if activeTurn == nil then
        grantNextQueuedSpeaker()
    end
end)

local function handlePlayerRemoving(player)
    removeQueuedClaimForPlayer(player.Name)
    if activeTurn and activeTurn.player_name == player.Name then
        releaseActiveTurn("player_left")
        grantNextQueuedSpeaker()
    end
    clearSpeakerByName(player.Name)
    grantNextQueuedSpeaker()
    cleanupPlayer(player)
end

--------------------------------------------------------------------------------
-- INITIALIZATION
--------------------------------------------------------------------------------

Players.PlayerAdded:Connect(setupPlayer)
Players.PlayerRemoving:Connect(handlePlayerRemoving)

for _, player in ipairs(Players:GetPlayers()) do
    setupPlayer(player)
end

countVoters()
gameState:SetAttribute("last_speech_at_ms", nowMs())

print("=== Survivor — Tribal Council ===")
