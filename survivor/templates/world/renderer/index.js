/* ───────────────────────────────────────────────────────
   Tribal Council — Live Visual-Novel Renderer
   Replaces Three.js renderer with DOM-based overlay
   driven by spectator WS speech events + onState player data.
   ─────────────────────────────────────────────────────── */

// ── Character data ──────────────────────────────────────
const CHARACTERS = {
  host:          { name: 'Jeff',          color: '#b8860b' },
  rodger_dodger: { name: 'Rodger Dodger', color: '#8B4513', portrait: '/assets/rodger-calm.JPG' },
  yasmin:        { name: 'Yasmin',        color: '#E74C3C' },
  guy:           { name: 'Guy',           color: '#3498DB' },
  stephanie:     { name: 'Stephanie',     color: '#9B59B6' },
  tommy:         { name: 'Tommy',         color: '#27AE60' },
}

const CHAR_ORDER = ['host', 'rodger_dodger', 'yasmin', 'guy', 'stephanie', 'tommy']

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

/* ── Character row ── */
#sv-chars {
  position: absolute; top: 0; left: 0; right: 0; bottom: 28%;
  display: flex; align-items: flex-end; justify-content: center;
  gap: 12px; padding: 0 24px 16px;
  z-index: 10; pointer-events: none;
}

.sv-char {
  display: flex; flex-direction: column; align-items: center;
  transition: filter 0.4s ease, transform 0.4s ease;
  filter: brightness(0.35) saturate(0.5);
  transform-origin: bottom center;
  position: relative;
}
.sv-char.speaking {
  filter: brightness(1) saturate(1) drop-shadow(0 0 18px rgba(255,140,40,0.5));
  transform: scale(1.08);
  z-index: 15;
}
.sv-char.voted .sv-badge { display: flex; }

/* Silhouette */
.sv-sil {
  width: 140px; height: 280px;
  border-radius: 50px 50px 20px 20px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 30px rgba(0,0,0,0.5);
  clip-path: polygon(
    30% 0%, 70% 0%, 80% 8%, 85% 20%, 83% 35%,
    95% 45%, 100% 55%, 95% 65%, 80% 60%,
    82% 75%, 78% 90%, 75% 100%, 25% 100%,
    22% 90%, 18% 75%, 20% 60%,
    5% 65%, 0% 55%, 5% 45%, 17% 35%,
    15% 20%, 20% 8%
  );
}

/* Portrait image (replaces silhouette) */
.sv-portrait {
  height: 280px; width: auto;
  object-fit: contain;
  filter: drop-shadow(0 4px 20px rgba(0,0,0,0.7));
}

.sv-name {
  margin-top: 6px;
  color: #fff; font-size: 13px; font-weight: bold;
  text-shadow: 0 2px 6px rgba(0,0,0,0.9);
  text-align: center;
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

/* ── Speech log ── */
#sv-log {
  position: absolute; top: 16px; left: 20px;
  z-index: 30;
  max-width: 340px; max-height: 40%;
  overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.2) transparent;
}
.sv-log-entry {
  font-size: 12px; line-height: 1.4;
  color: rgba(255,255,255,0.45);
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}
.sv-log-name {
  font-weight: bold;
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

/* ── Responsive ── */
@media (max-width: 768px) {
  .sv-sil, .sv-portrait { width: 90px; height: 180px; }
  #sv-dlg { height: 32%; padding: 14px 18px; }
  #sv-text { font-size: 15px; }
  #sv-speaker { font-size: 16px; }
  #sv-title h1 { font-size: 36px; letter-spacing: 6px; }
  #sv-log { max-width: 220px; }
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
    <div id="sv-log"></div>
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
  const $log      = root.querySelector('#sv-log')
  const $title    = root.querySelector('#sv-title')

  // ── State ──
  let players = []
  let playersHash = ''
  let titleVisible = true
  let typewriterTimer = null

  // ── Helpers ──
  function charData(agentName) {
    return CHARACTERS[agentName] || { name: agentName, color: '#888' }
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

  // ── Render characters ──
  function renderCharacters() {
    $chars.innerHTML = ''
    // Order: show chars in CHAR_ORDER that exist in players, then any extras
    const playerMap = new Map()
    for (const p of players) playerMap.set(p.name, p)

    const ordered = []
    for (const key of CHAR_ORDER) {
      if (playerMap.has(key)) ordered.push(playerMap.get(key))
    }
    for (const p of players) {
      if (!CHAR_ORDER.includes(p.name)) ordered.push(p)
    }

    for (const p of ordered) {
      const cd = charData(p.name)
      const hasVoted = playerHasVoted(p)
      const isSpeaking = p.attributes?.IsSpeaking === true

      const el = document.createElement('div')
      el.className = 'sv-char'
      if (isSpeaking) el.classList.add('speaking')
      if (hasVoted)   el.classList.add('voted')

      if (cd.portrait) {
        const img = document.createElement('img')
        img.className = 'sv-portrait'
        img.src = cd.portrait
        img.alt = cd.name
        el.appendChild(img)
      } else {
        const sil = document.createElement('div')
        sil.className = 'sv-sil'
        sil.style.backgroundColor = cd.color
        el.appendChild(sil)
      }

      const badge = document.createElement('div')
      badge.className = 'sv-badge'
      badge.textContent = '\u2713'
      el.appendChild(badge)

      const nameTag = document.createElement('div')
      nameTag.className = 'sv-name'
      nameTag.textContent = cd.name
      el.appendChild(nameTag)

      $chars.appendChild(el)
    }
  }

  // ── Vote HUD ──
  function updateVoteHud() {
    const total = players.length
    if (total === 0) {
      $hudLabel.textContent = ''
      $hudFill.style.width = '0%'
      return
    }
    const voted = players.filter(p => playerHasVoted(p)).length
    $hudLabel.textContent = `Votes: ${voted} / ${total}`
    $hudFill.style.width = `${Math.round((voted / total) * 100)}%`
  }

  // ── Speech display ──
  function showSpeech(speaker, text) {
    if (titleVisible) {
      titleVisible = false
      $title.classList.add('hidden')
    }

    const cd = charData(speaker)
    $speaker.textContent = cd.name
    $speaker.style.color = cd.color

    // Typewriter
    if (typewriterTimer) clearInterval(typewriterTimer)
    $text.textContent = ''
    let i = 0
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

  function appendLog(speaker, text) {
    const cd = charData(speaker)
    const entry = document.createElement('div')
    entry.className = 'sv-log-entry'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'sv-log-name'
    nameSpan.style.color = cd.color
    nameSpan.textContent = cd.name + ': '
    entry.appendChild(nameSpan)

    const textNode = document.createTextNode(text.length > 120 ? text.slice(0, 117) + '...' : text)
    entry.appendChild(textNode)

    $log.appendChild(entry)
    $log.scrollTop = $log.scrollHeight
  }

  // ── Renderer lifecycle ──
  return {
    onState(state) {
      // Speech events arrive as {type: "speech", speaker, text, seq}
      if (state.type === 'speech') {
        appendLog(state.speaker, state.text)
        showSpeech(state.speaker, state.text)
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
        players = newPlayers
        playersHash = h
        renderCharacters()
        updateVoteHud()
      }
    },

    onResize() {
      // DOM-based, nothing to do
    },

    unmount() {
      if (typewriterTimer) clearInterval(typewriterTimer)
      root.remove()
      styleEl.remove()
      ctx.canvas.style.display = ''
    },
  }
}
