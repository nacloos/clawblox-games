/* ───────────────────────────────────────────────────────
   Tribal Council — Live Visual-Novel Renderer
   Persona-style large portraits with mood-based expressions,
   driven by spectator WS speech events + onState player data.
   ─────────────────────────────────────────────────────── */

// ── Character data ──────────────────────────────────────
const CHARACTERS = {
  host: {
    name: 'Jeff',
    color: '#b8860b',
    expressions: ['neutral', 'serious', 'intrigued'],
    assets: {
      neutral:   '/assets/host.png',
      serious:   '/assets/host.png',
      intrigued: '/assets/host.png',
    },
  },
  rodger_dodger: {
    name: 'Rodger Dodger',
    color: '#8B4513',
    expressions: ['stoic', 'smug', 'angry', 'hurt', 'proud'],
    assets: {
      stoic:  '/assets/roger.png',
      smug:   '/assets/roger-happy.png',
      proud:  '/assets/roger.png',
      angry:  '/assets/roger-angry.png',
      hurt:   '/assets/roger-sad.png',
    },
  },
  yasmin: {
    name: 'Yasmin',
    color: '#E74C3C',
    expressions: ['smug', 'flirty', 'angry', 'composed', 'wounded'],
    assets: {
      smug:     '/assets/yasmin-happy.png',
      flirty:   '/assets/yasmin-happy.png',
      angry:    '/assets/yasmin-angry.png',
      composed: '/assets/yasmin.png',
      wounded:  '/assets/yasmin-sad.png',
    },
  },
  guy: {
    name: 'Guy',
    color: '#3498DB',
    expressions: ['smug', 'nervous', 'flustered', 'calculating', 'pleased'],
    assets: {
      smug:        '/assets/guy-happy.png',
      nervous:     '/assets/guy-sad.png',
      flustered:   '/assets/guy-sad.png',
      calculating: '/assets/guy-angry.png',
      pleased:     '/assets/guy-happy.png',
    },
  },
  stephanie: {
    name: 'Stephanie',
    color: '#9B59B6',
    expressions: ['anxious', 'hurt', 'suspicious', 'flustered', 'defiant'],
    assets: {
      anxious:    '/assets/stephanie-sad.png',
      hurt:       '/assets/stephanie-sad.png',
      suspicious: '/assets/stephanie.png',
      flustered:  '/assets/stephanie-sad.png',
      defiant:    '/assets/stephanie-angry.png',
    },
  },
  tommy: {
    name: 'Tommy',
    color: '#27AE60',
    expressions: ['stoic', 'angry', 'conflicted', 'protective', 'weary'],
    assets: {
      stoic:       '/assets/tommy.png',
      angry:       '/assets/tommy-angry.png',
      conflicted:  '/assets/tommy-sad.png',
      protective:  '/assets/tommy-angry.png',
      weary:       '/assets/tommy.png',
    },
  },
}

const CHAR_ORDER = ['host', 'rodger_dodger', 'yasmin', 'guy', 'stephanie', 'tommy']
const DEBUG_SPEECH_SYNC = true
const MUSIC_PHASE_TRACK = {
  voting: 'normal',
  awaiting_reveal: 'normal',
  result: 'sped',
}

// ── Embedded CSS ────────────────────────────────────────
const STYLES = `
/* reset within overlay */
#sv, #sv * { margin:0; padding:0; box-sizing:border-box; }

#sv {
  position: fixed; inset: 0; z-index: 9999;
  font-family: 'Georgia', serif;
  user-select: none;
  overflow: hidden;
}

/* ── Background ── */
#sv-bg {
  position: absolute; inset: 0;
  background:
    url('/assets/setting.png') center/cover no-repeat,
    radial-gradient(ellipse at 50% 80%, #3a1a00 0%, #1a0a00 50%, #000 100%);
  filter: brightness(0.35) blur(1px);
  transform: scale(1.03);
}
#sv-bg::after {
  content: "";
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%);
}

/* ── Character area (absolute positioned) ── */
#sv-chars {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 10;
  pointer-events: none;
}

/* ── Persona-style large portraits ── */
.character-sprite {
  position: absolute;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  opacity: 0;
  transition: opacity 0.4s ease, filter 0.4s ease, transform 0.4s ease;
  filter: brightness(0.4) saturate(0.4);
  transform-origin: bottom center;
}
.character-sprite.visible {
  opacity: 1;
}
.character-sprite.speaking {
  filter: brightness(1) saturate(1);
  z-index: 15;
}
.character-sprite:not(.speaking) {
  filter: brightness(0.4) saturate(0.4);
}

.char-portrait {
  position: relative;
  height: 85vh;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.char-img {
  height: 100%;
  width: auto;
  object-fit: contain;
  filter: drop-shadow(0 4px 20px rgba(0,0,0,0.7));
}

/* ── Edge-based positioning ── */
.character-sprite.pos-center {
  left: 50%;
  transform: translateX(-50%);
}
.character-sprite.pos-center.speaking {
  transform: translateX(-50%) scale(1.03);
}
.character-sprite.pos-left {
  left: -2%;
  transform: translateX(0);
}
.character-sprite.pos-left.speaking {
  transform: translateX(0) scale(1.03);
}
.character-sprite.pos-right {
  right: -2%;
  left: auto;
  transform: translateX(0);
}
.character-sprite.pos-right.speaking {
  transform: translateX(0) scale(1.03);
}

/* Silhouette fallback */
.char-silhouette {
  width: 240px;
  height: 85vh;
  border-radius: 70px 70px 30px 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  box-shadow: 0 0 40px rgba(0,0,0,0.6);
  clip-path: polygon(
    30% 0%, 70% 0%, 80% 8%, 85% 20%, 83% 35%,
    95% 45%, 100% 55%, 95% 65%, 80% 60%,
    82% 75%, 78% 90%, 75% 100%, 25% 100%,
    22% 90%, 18% 75%, 20% 60%,
    5% 65%, 0% 55%, 5% 45%, 17% 35%,
    15% 20%, 20% 8%
  );
}

/* Vote badge */
.sv-badge {
  display: none;
  position: absolute; top: -4px; right: -4px;
  width: 28px; height: 28px; border-radius: 50%;
  background: #27AE60;
  align-items: center; justify-content: center;
  font-size: 16px; color: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.6);
  z-index: 20;
}
.character-sprite.voted .sv-badge { display: flex; }

/* ── Dialogue box ── */
#sv-dlg {
  position: absolute; bottom: 0; left: 0; right: 0;
  height: 28%;
  background: linear-gradient(to bottom, rgba(0,0,0,0.88), rgba(0,0,0,0.96));
  border-top: 2px solid rgba(255,140,40,0.4);
  z-index: 20;
  padding: 20px 40px;
  display: flex; flex-direction: column;
}

#sv-speaker {
  font-size: 20px; font-weight: bold;
  text-transform: uppercase; letter-spacing: 2px;
  margin-bottom: 10px;
  text-shadow: 0 0 10px currentColor;
}

#sv-text {
  color: #e8e0d0; font-size: 18px; line-height: 1.6;
  flex: 1;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  overflow-y: auto;
}

/* ── Vote HUD ── */
#sv-hud {
  position: absolute; top: 16px; right: 20px;
  z-index: 30;
  color: rgba(255,255,255,0.7);
  font-size: 13px; font-family: monospace;
  text-shadow: 0 1px 4px rgba(0,0,0,0.8);
}
#sv-hud-bar {
  margin-top: 4px;
  width: 120px; height: 6px;
  background: rgba(255,255,255,0.15);
  border-radius: 3px; overflow: hidden;
}
#sv-hud-fill {
  height: 100%; width: 0%;
  background: #27AE60;
  border-radius: 3px;
  transition: width 0.4s ease;
}


/* ── Title overlay ── */
#sv-title {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  z-index: 50;
  text-align: center;
  transition: opacity 1.2s ease-out;
  pointer-events: none;
}
#sv-title.hidden { opacity: 0; }

#sv-title h1 {
  font-size: 64px; color: #e8d0a0;
  letter-spacing: 12px;
  text-shadow:
    0 0 40px rgba(255,120,20,0.6),
    0 0 80px rgba(255,80,0,0.3),
    0 4px 8px rgba(0,0,0,0.8);
  animation: sv-glow 3s ease-in-out infinite alternate;
}
#sv-title p {
  margin-top: 12px;
  font-size: 18px; color: rgba(255,200,140,0.6);
  font-style: italic; letter-spacing: 4px;
  text-shadow: 0 2px 6px rgba(0,0,0,0.8);
}

@keyframes sv-glow {
  0%   { text-shadow: 0 0 40px rgba(255,120,20,0.4), 0 0 80px rgba(255,80,0,0.2), 0 4px 8px rgba(0,0,0,0.8); }
  100% { text-shadow: 0 0 60px rgba(255,120,20,0.8), 0 0 120px rgba(255,80,0,0.4), 0 4px 8px rgba(0,0,0,0.8); }
}

/* ── Screen shake ── */
.shake-screen {
  animation: screenShake 0.4s ease-out;
}
@keyframes screenShake {
  0%, 100% { transform: translate(0, 0); }
  15% { transform: translate(-3px, 1px); }
  30% { transform: translate(3px, -1px); }
  45% { transform: translate(-2px, 2px); }
  60% { transform: translate(2px, -1px); }
  75% { transform: translate(-1px, 1px); }
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .char-portrait { height: 75vh; }
  .char-silhouette { width: 160px; height: 75vh; }
  #sv-dlg { height: 32%; padding: 14px 18px; }
  #sv-text { font-size: 15px; }
  #sv-speaker { font-size: 16px; }
  #sv-title h1 { font-size: 36px; letter-spacing: 6px; }
}
`

// ── Renderer entry point ────────────────────────────────
export function createRenderer(ctx) {
  // Hide the canvas the runtime provides
  ctx.canvas.style.display = 'none'
  const parent = ctx.canvas.parentElement || document.body

  // Inject styles
  const styleEl = document.createElement('style')
  styleEl.textContent = STYLES
  document.head.appendChild(styleEl)

  // Build DOM
  const root = document.createElement('div')
  root.id = 'sv'
  root.innerHTML = `
    <div id="sv-bg"></div>
    <div id="sv-chars"></div>
    <div id="sv-hud">
      <span id="sv-hud-label"></span>
      <div id="sv-hud-bar"><div id="sv-hud-fill"></div></div>
    </div>
    <div id="sv-dlg">
      <div id="sv-speaker"></div>
      <div id="sv-text"></div>
    </div>
    <div id="sv-title">
      <h1>TRIBAL COUNCIL</h1>
      <p>The tribe has spoken.</p>
    </div>
  `
  parent.appendChild(root)

  // Grab DOM refs
  const $chars    = root.querySelector('#sv-chars')
  const $speaker  = root.querySelector('#sv-speaker')
  const $text     = root.querySelector('#sv-text')
  const $hudLabel = root.querySelector('#sv-hud-label')
  const $hudFill  = root.querySelector('#sv-hud-fill')
  const $title    = root.querySelector('#sv-title')

  // ── State ──
  let players = []
  let playersHash = ''
  let titleVisible = true
  let typewriterTimer = null
  let currentSpeaker = null   // agent name of current speaker
  let previousSpeaker = null  // agent name of previous speaker
  let hasSpeechStarted = false
  let progressSpeaker = null
  let lastRenderSignature = ''
  let gamePhase = 'voting'
  let votesReceived = 0
  let totalVoters = 0

  // ── Background music (phase-based) ──
  const MUSIC_VOL = 0.4
  const MUSIC_FADE_MS = 1000
  const bgMusic = new Audio('/assets/bg.mp3')
  const bgSped = new Audio('/assets/bg-sped.mp3')
  bgMusic.loop = true
  bgSped.loop = true
  bgMusic.preload = 'auto'
  bgSped.preload = 'auto'
  bgMusic.volume = 0
  bgSped.volume = 0
  let currentTrack = 'normal'
  let desiredTrack = 'normal'
  let audioUnlocked = false
  let fadeTimer = null

  function clearFadeTimer() {
    if (fadeTimer) {
      clearInterval(fadeTimer)
      fadeTimer = null
    }
  }

  function getTrackForPhase(phase) {
    return MUSIC_PHASE_TRACK[phase] || 'normal'
  }

  function applyTrackVolumes(track) {
    if (track === 'sped') {
      bgMusic.volume = 0
      bgSped.volume = MUSIC_VOL
    } else {
      bgMusic.volume = MUSIC_VOL
      bgSped.volume = 0
    }
    currentTrack = track
  }

  function switchMusic(track) {
    if (!audioUnlocked) {
      desiredTrack = track
      return
    }
    if (track === currentTrack) return
    desiredTrack = track

    const fadeOut = track === 'sped' ? bgMusic : bgSped
    const fadeIn = track === 'sped' ? bgSped : bgMusic
    clearFadeTimer()
    const steps = 25
    const interval = Math.max(16, Math.round(MUSIC_FADE_MS / steps))
    let step = 0
    const startOut = fadeOut.volume
    const startIn = fadeIn.volume
    fadeTimer = setInterval(() => {
      step += 1
      const progress = step / steps
      fadeOut.volume = Math.max(0, startOut * (1 - progress))
      fadeIn.volume = Math.min(MUSIC_VOL, startIn + (MUSIC_VOL - startIn) * progress)
      if (step >= steps) {
        clearFadeTimer()
        applyTrackVolumes(track)
      }
    }, interval)
  }

  async function unlockAudio() {
    if (audioUnlocked) return
    audioUnlocked = true
    try {
      await Promise.all([
        bgMusic.play(),
        bgSped.play(),
      ])
      applyTrackVolumes(desiredTrack)
    } catch (err) {
      console.warn('[audio] failed to start background music', err)
      audioUnlocked = false
    }
  }

  function maybeUnlockAudio() {
    void unlockAudio()
  }

  window.addEventListener('pointerdown', maybeUnlockAudio, { once: true, passive: true })
  window.addEventListener('keydown', maybeUnlockAudio, { once: true })

  function dbg(msg) {
    if (!DEBUG_SPEECH_SYNC) return
    console.log(`[sv-debug] ${msg}`)
  }

  function lockedSpeakerFromPlayers(list) {
    const speaking = list.filter((p) => p?.attributes?.IsSpeaking === true)
    if (speaking.length === 1) return speaking[0].name
    if (speaking.length > 1) return speaking.map((p) => p.name).join(',')
    return ''
  }

  // ── Helpers ──
  function charData(agentName) {
    return CHARACTERS[agentName] || { name: agentName, color: '#888', expressions: [], assets: {} }
  }

  function hashPlayers(list) {
    return list.map(p => {
      const attrs = p.attributes || {}
      const entries = Object.keys(attrs).sort().map(k => `${k}=${attrs[k]}`).join(',')
      return `${p.name}:${entries}`
    }).join('|')
  }

  function playerHasVoted(p) {
    const attrs = p.attributes
    return attrs && attrs.HasVoted === true
  }

  // ── Asset helpers ──
  function getAssetForMood(cd, mood) {
    if (!cd.assets) return null
    if (cd.assets[mood]) return cd.assets[mood]
    // Fallback to calm/neutral, then first available
    if (cd.assets.calm) return cd.assets.calm
    if (cd.assets.neutral) return cd.assets.neutral
    if (cd.assets.stoic) return cd.assets.stoic
    if (cd.assets.composed) return cd.assets.composed
    const vals = Object.values(cd.assets)
    return vals.length > 0 ? vals[0] : null
  }

  function preloadAssets() {
    for (const cd of Object.values(CHARACTERS)) {
      if (!cd.assets) continue
      for (const src of new Set(Object.values(cd.assets))) {
        const img = new Image()
        img.src = src
      }
    }
  }

  // ── Position character (Persona-style edge positioning) ──
  function positionCharacter(el, index, total) {
    if (total === 1) {
      el.classList.add('pos-center')
    } else if (total === 2) {
      el.classList.add(index === 0 ? 'pos-left' : 'pos-right')
    } else {
      // Spread evenly
      const spacing = 80 / (total + 1)
      el.style.left = (10 + spacing * (index + 1)) + '%'
      el.style.transform = 'translateX(-50%)'
    }
  }

  // ── Build a character DOM element ──
  function buildCharacterEl(agentName, isSpeaking, hasVoted) {
    const cd = charData(agentName)
    const mood = cd.expressions ? cd.expressions[0] : 'neutral'
    const assetSrc = getAssetForMood(cd, mood)

    const el = document.createElement('div')
    el.className = 'character-sprite'
    if (isSpeaking) el.classList.add('speaking')
    if (hasVoted) el.classList.add('voted')

    if (assetSrc) {
      const portrait = document.createElement('div')
      portrait.className = 'char-portrait'
      const img = document.createElement('img')
      img.className = 'char-img'
      img.src = assetSrc
      img.alt = cd.name
      portrait.appendChild(img)
      el.appendChild(portrait)
    } else {
      const sil = document.createElement('div')
      sil.className = 'char-silhouette'
      sil.style.backgroundColor = cd.color
      el.appendChild(sil)
    }

    const badge = document.createElement('div')
    badge.className = 'sv-badge'
    badge.textContent = '\u2713'
    el.appendChild(badge)

    return el
  }

  // ── Render characters ──
  function renderCharacters() {
    if (!hasSpeechStarted) {
      // Before any speech: show all characters spread out (initial council view)
      const playerMap = new Map()
      for (const p of players) playerMap.set(p.name, p)

      const ordered = []
      for (const key of CHAR_ORDER) {
        if (playerMap.has(key)) ordered.push(playerMap.get(key))
      }
      for (const p of players) {
        if (!CHAR_ORDER.includes(p.name)) ordered.push(p)
      }

      const lock = lockedSpeakerFromPlayers(players)
      const sig = `pre|all=${ordered.map((p) => p.name).join(',')}|voted=${ordered.map((p) => (playerHasVoted(p) ? '1' : '0')).join('')}`
      if (sig === lastRenderSignature) {
        return
      }

      $chars.innerHTML = ''
      const total = ordered.length
      ordered.forEach((p, i) => {
        const isSpeaking = p.attributes?.IsSpeaking === true
        const hasVoted = playerHasVoted(p)
        const el = buildCharacterEl(p.name, isSpeaking, hasVoted)
        positionCharacter(el, i, total)
        $chars.appendChild(el)
        requestAnimationFrame(() => el.classList.add('visible'))
      })
      dbg(`render pre-speech pre|lock=${lock}|all=${ordered.map((p) => p.name).join(',')}`)
      lastRenderSignature = sig
      return
    }

    // After speech started: show current speaker (left) and previous speaker (right)
    const toShow = []
    if (currentSpeaker) toShow.push({ name: currentSpeaker, isSpeaking: true })
    if (previousSpeaker && previousSpeaker !== currentSpeaker) {
      toShow.push({ name: previousSpeaker, isSpeaking: false })
    }

    // Find vote status from players list
    const playerMap = new Map()
    for (const p of players) playerMap.set(p.name, p)

    const lock = lockedSpeakerFromPlayers(players)
    const sig = `post|current=${currentSpeaker || ''}|prev=${previousSpeaker || ''}|show=${toShow.map((e) => e.name).join(',')}|voted=${toShow.map((entry) => {
      const p = playerMap.get(entry.name)
      return p && playerHasVoted(p) ? '1' : '0'
    }).join('')}`
    if (sig === lastRenderSignature) {
      return
    }

    $chars.innerHTML = ''
    toShow.forEach((entry, i) => {
      const p = playerMap.get(entry.name)
      const hasVoted = p ? playerHasVoted(p) : false
      const el = buildCharacterEl(entry.name, entry.isSpeaking, hasVoted)
      positionCharacter(el, i, toShow.length)
      $chars.appendChild(el)
      requestAnimationFrame(() => el.classList.add('visible'))
    })
    dbg(`render post-speech post|lock=${lock}|current=${currentSpeaker || ''}|prev=${previousSpeaker || ''}|show=${toShow.map((e) => e.name).join(',')}`)
    lastRenderSignature = sig
  }

  // ── Vote HUD ──
  function updateVoteHud() {
    let total = totalVoters
    let voted = votesReceived

    // Fallback for older frames that don't include GameState vote counters.
    if (typeof total !== 'number' || total <= 0) {
      const nonHost = players.filter((p) => p.name !== 'host')
      total = nonHost.length
      voted = nonHost.filter((p) => playerHasVoted(p)).length
    }

    if (total === 0) {
      $hudLabel.textContent = ''
      $hudFill.style.width = '0%'
      return
    }
    $hudLabel.textContent = `Votes: ${voted} / ${total}`
    $hudFill.style.width = `${Math.round((voted / total) * 100)}%`
  }

  // ── Speech display ──
  function showSpeech(speaker, text, options = {}) {
    const progress = options.progress === true
    const instant = options.instant === true
    if (titleVisible) {
      titleVisible = false
      $title.classList.add('hidden')
    }

    hasSpeechStarted = true

    // Track speaker transitions
    if (speaker !== currentSpeaker) {
      const lock = lockedSpeakerFromPlayers(players)
      dbg(`showSpeech switch speaker=${speaker} progress=${progress} instant=${instant} oldCurrent=${currentSpeaker || ''} oldPrev=${previousSpeaker || ''} lock=${lock || '(none)'}`)
      previousSpeaker = currentSpeaker
      currentSpeaker = speaker
      renderCharacters()
    }

    const cd = charData(speaker)
    $speaker.textContent = cd.name
    $speaker.style.color = cd.color

    if (progress || instant) {
      if (typewriterTimer) {
        clearInterval(typewriterTimer)
        typewriterTimer = null
      }
      $text.textContent = text
      const lock = lockedSpeakerFromPlayers(players)
      dbg(`showSpeech apply speaker=${speaker} mode=${progress ? 'progress' : 'instant'} textLen=${text.length} lock=${lock || '(none)'}`)
      return
    }

    // Typewriter
    if (typewriterTimer) clearInterval(typewriterTimer)
    $text.textContent = ''
    let i = 0
    const lock = lockedSpeakerFromPlayers(players)
    dbg(`showSpeech apply speaker=${speaker} mode=typewriter textLen=${text.length} lock=${lock || '(none)'}`)
    typewriterTimer = setInterval(() => {
      if (i < text.length) {
        $text.textContent += text[i]
        i++
      } else {
        clearInterval(typewriterTimer)
        typewriterTimer = null
      }
    }, 25)
  }

  // ── Preload all assets on init ──
  preloadAssets()
  desiredTrack = getTrackForPhase(gamePhase)
  switchMusic(desiredTrack)

  function extractGamePhase(state) {
    if (!state || !Array.isArray(state.entities)) return null
    for (const entity of state.entities) {
      if (!entity || entity.name !== 'GameState') continue
      const attrs = entity.attributes || {}
      if (typeof attrs.phase === 'string' && attrs.phase.length > 0) {
        return attrs.phase
      }
    }
    return null
  }

  function extractGameStateAttributes(state) {
    if (!state || !Array.isArray(state.entities)) return null
    for (const entity of state.entities) {
      if (!entity || entity.name !== 'GameState') continue
      return entity.attributes || {}
    }
    return null
  }

  // ── Renderer lifecycle ──
  return {
    onState(state) {
      const gameStateAttrs = extractGameStateAttributes(state)
      if (gameStateAttrs) {
        if (typeof gameStateAttrs.votes_received === 'number') {
          votesReceived = gameStateAttrs.votes_received
        }
        if (typeof gameStateAttrs.total_voters === 'number') {
          totalVoters = gameStateAttrs.total_voters
        }
      }

      const nextPhase = extractGamePhase(state)
      if (nextPhase && nextPhase !== gamePhase) {
        gamePhase = nextPhase
        switchMusic(getTrackForPhase(gamePhase))
      }

      if (state.type === 'speech_progress') {
        const text = typeof state.text === 'string' ? state.text : ''
        const lock = lockedSpeakerFromPlayers(players)
        const seq = state.seq ?? '?'
        dbg(`speech progress seq=${seq} speaker=${state.speaker} textLen=${text.length} lock=${lock || '(none)'} current=${currentSpeaker || ''} progressSpeaker=${progressSpeaker || ''}`)
        if (lock && lock !== state.speaker) {
          dbg(`WARNING speaker/lock mismatch at speech progress: speaker=${state.speaker} lock=${lock}`)
        }
        progressSpeaker = state.speaker
        showSpeech(state.speaker, text, { progress: true })
        return
      }

      // Committed speech event: authoritative turn output.
      if (state.type === 'speech') {
        const text = typeof state.text === 'string' ? state.text : ''
        const lock = lockedSpeakerFromPlayers(players)
        const seq = state.seq ?? '?'
        dbg(`speech final seq=${seq} speaker=${state.speaker} textLen=${text.length} lock=${lock || '(none)'} current=${currentSpeaker || ''} progressSpeaker=${progressSpeaker || ''}`)
        if (lock && lock !== state.speaker) {
          dbg(`WARNING speaker/lock mismatch at speech final: speaker=${state.speaker} lock=${lock}`)
        }
        const instant = progressSpeaker === state.speaker
        progressSpeaker = null
        showSpeech(state.speaker, text, { instant })
        return
      }

      // Normal spectator state frame
      const newPlayers = state.players || []
      const h = hashPlayers(newPlayers)
      if (h !== playersHash) {
        // Log IsSpeaking changes
        for (const np of newPlayers) {
          const old = players.find(p => p.name === np.name)
          const wasSpeaking = old?.attributes?.IsSpeaking === true
          const nowSpeaking = np.attributes?.IsSpeaking === true
          if (nowSpeaking && !wasSpeaking) {
            console.log(`[speaking] ${np.name} claimed speaking lock`)
          } else if (!nowSpeaking && wasSpeaking) {
            console.log(`[speaking] ${np.name} released speaking lock`)
          }
        }
        const lockBefore = lockedSpeakerFromPlayers(players)
        players = newPlayers
        playersHash = h
        const lockAfter = lockedSpeakerFromPlayers(players)
        if (lockBefore !== lockAfter) {
          dbg(`lock changed before=${lockBefore || '(none)'} after=${lockAfter || '(none)'} current=${currentSpeaker || ''} prev=${previousSpeaker || ''}`)
          if (lockAfter && currentSpeaker && lockAfter !== currentSpeaker) {
            dbg(`WARNING lock/UI mismatch after state update: lock=${lockAfter} uiCurrent=${currentSpeaker}`)
          }
        }
        renderCharacters()
        updateVoteHud()
      }
    },

    onResize() {
      // DOM-based, nothing to do
    },

    unmount() {
      if (typewriterTimer) clearInterval(typewriterTimer)
      clearFadeTimer()
      window.removeEventListener('pointerdown', maybeUnlockAudio)
      window.removeEventListener('keydown', maybeUnlockAudio)
      bgMusic.pause()
      bgSped.pause()
      bgMusic.currentTime = 0
      bgSped.currentTime = 0
      root.remove()
      styleEl.remove()
      ctx.canvas.style.display = ''
    },
  }
}
