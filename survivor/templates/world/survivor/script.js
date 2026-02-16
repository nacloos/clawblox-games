const game = {
  currentLine: 0,
  isAnimating: false,
  textSpeed: 30,
  currentText: "",
  textTimer: null,
  audioStarted: false,
  currentTrack: "normal",

  init() {
    this.dialogueBox = document.getElementById("dialogue-text");
    this.speakerLabel = document.getElementById("speaker-name");
    this.characterArea = document.getElementById("character-area");
    this.clickZone = document.getElementById("game-container");
    this.advanceIndicator = document.getElementById("advance-indicator");

    // Audio setup — HTML audio elements (works with file:// protocol)
    this.bgMusic = document.getElementById("audio-bg");
    this.bgSped = document.getElementById("audio-sped");
    this.bgMusic.volume = 0.4;
    this.bgSped.volume = 0;
    this.fadeTimer = null;

    // Title screen handles first interaction + audio start
    this.titleScreen = document.getElementById("title-screen");
    this.gameStarted = false;

    const startGame = () => {
      if (this.gameStarted) return;
      this.gameStarted = true;

      // Start both tracks — sped plays silently for instant crossfade
      this.audioStarted = true;
      this.bgMusic.play().catch(() => {});
      this.bgSped.play().catch(() => {});

      // Transition: fade out title, show game
      this.titleScreen.classList.add("fade-out");
      setTimeout(() => {
        this.titleScreen.classList.add("hidden");
        this.clickZone.classList.remove("hidden");
        this.clickZone.classList.add("fade-in");
        this.showLine(0);
      }, 1000);
    };

    this.titleScreen.addEventListener("click", startGame);
    document.addEventListener("keydown", (e) => {
      if ((e.code === "Space" || e.code === "Enter") && !this.gameStarted) {
        e.preventDefault();
        startGame();
        return;
      }
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        this.advance();
      }
    });

    this.clickZone.addEventListener("click", () => this.advance());
  },


  advance() {
    if (this.isAnimating) {
      clearInterval(this.textTimer);
      this.dialogueBox.textContent = this.currentText;
      this.isAnimating = false;
      this.advanceIndicator.style.opacity = "1";
      return;
    }

    if (this.currentLine < SCREENPLAY.length - 1) {
      this.currentLine++;
      this.showLine(this.currentLine);
    }
  },

  showLine(index) {
    const line = SCREENPLAY[index];
    const character = CHARACTERS[line.speaker];

    this.speakerLabel.textContent = character.name;
    this.speakerLabel.style.color = character.color;

    // Handle music switches
    if (line.music) {
      this.switchMusic(line.music);
    }

    this.updateCharacters(line);
    this.animateText(line.text);
  },

  switchMusic(track) {
    if (track === this.currentTrack || !this.audioStarted) return;
    this.currentTrack = track;

    const fadeOut = track === "sped" ? this.bgMusic : this.bgSped;
    const fadeIn = track === "sped" ? this.bgSped : this.bgMusic;

    // Crossfade over 1 second
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    const steps = 25;
    const interval = 1000 / steps;
    let step = 0;
    const startOut = fadeOut.volume;

    this.fadeTimer = setInterval(() => {
      step++;
      const progress = step / steps;
      fadeOut.volume = Math.max(0, startOut * (1 - progress));
      fadeIn.volume = Math.min(0.4, 0.4 * progress);
      if (step >= steps) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
    }, interval);
  },

  animateText(text) {
    this.currentText = text;
    this.dialogueBox.textContent = "";
    this.isAnimating = true;
    this.advanceIndicator.style.opacity = "0";
    let charIndex = 0;

    this.textTimer = setInterval(() => {
      if (charIndex < text.length) {
        this.dialogueBox.textContent += text[charIndex];
        charIndex++;
      } else {
        clearInterval(this.textTimer);
        this.isAnimating = false;
        this.advanceIndicator.style.opacity = "1";
      }
    }, this.textSpeed);
  },

  updateCharacters(line) {
    this.characterArea.innerHTML = "";

    // Build list of characters to show
    let allChars = [...line.visible];
    if (line.reaction && !allChars.includes(line.reaction.char)) {
      allChars.push(line.reaction.char);
    }

    const total = allChars.length;

    // Trigger screen shake for angry reactions
    if (line.reaction && (line.reaction.mood === "angry" || line.reaction.mood === "hurt")) {
      this.shakeScreen();
    }

    allChars.forEach((charKey, i) => {
      const charData = CHARACTERS[charKey];
      if (!charData) return;

      const isSpeaker = charKey === line.speaker;
      const isReacting = line.reaction && charKey === line.reaction.char;
      const mood = isReacting ? line.reaction.mood : (isSpeaker ? line.mood : charData.expressions[0]);

      const el = document.createElement("div");
      el.className = "character-sprite";
      if (isSpeaker) el.classList.add("speaking");
      if (isReacting && !isSpeaker) el.classList.add("reacting");

      // Persona-style edge positioning
      this.positionCharacter(el, i, total);

      // Build character HTML
      let reactionIndicatorHTML = "";
      if (isReacting && !isSpeaker) {
        reactionIndicatorHTML = `<div class="reaction-indicator">${getReactionEmoji(line.reaction.mood)}</div>`;
      }

      // Use image asset if available (exact mood or any asset so we never show placeholder for a character who has art)
      const assetSrc = charData.assets && (charData.assets[mood] || Object.values(charData.assets)[0]);
      if (assetSrc) {
        el.innerHTML = `
          <div class="char-portrait">
            <img src="${assetSrc}" alt="${charData.name} - ${mood}" class="char-img">
            ${reactionIndicatorHTML}
          </div>
        `;
      } else {
        el.innerHTML = `
          <div class="char-silhouette" style="background-color: ${charData.color}">
            <div class="char-face">${getMoodEmoji(mood)}</div>
            ${reactionIndicatorHTML}
          </div>
        `;
      }

      this.characterArea.appendChild(el);
      requestAnimationFrame(() => el.classList.add("visible"));
    });
  },

  positionCharacter(el, index, total) {
    if (total === 1) {
      el.classList.add("pos-center");
    } else if (total === 2) {
      el.classList.add(index === 0 ? "pos-left" : "pos-right");
    } else if (total === 3) {
      el.classList.add(`pos-3-${index}`);
    } else {
      // Fallback spread
      const spacing = 80 / (total + 1);
      el.style.left = (10 + spacing * (index + 1)) + "%";
      el.style.transform = "translateX(-50%)";
    }
  },

  shakeScreen() {
    const container = document.getElementById("game-container");
    container.classList.remove("shake-screen");
    void container.offsetWidth; // force reflow
    container.classList.add("shake-screen");
    setTimeout(() => container.classList.remove("shake-screen"), 500);
  }
};

function getMoodEmoji(mood) {
  const map = {
    neutral: "\u{1F610}", serious: "\u{1F611}", intrigued: "\u{1F914}",
    stoic: "\u{1F610}", smug: "\u{1F60F}", angry: "\u{1F620}", hurt: "\u{1F61E}", proud: "\u{1F624}",
    anxious: "\u{1F630}", suspicious: "\u{1F928}", flustered: "\u{1F633}", defiant: "\u{1F624}",
    flirty: "\u{1F60F}", composed: "\u{1F60C}", wounded: "\u{1F622}",
    nervous: "\u{1F62C}", calculating: "\u{1F9D0}", pleased: "\u{1F60A}",
    conflicted: "\u{1F61F}", protective: "\u{1F6E1}", weary: "\u{1F614}"
  };
  return map[mood] || "\u{1F610}";
}

function getReactionEmoji(mood) {
  const map = {
    angry: "\u{1F4A2}",      // anger symbol
    hurt: "\u{1F494}",       // broken heart
    nervous: "\u{1F4A6}",    // sweat drops
    flustered: "\u{2757}",   // exclamation
    wounded: "\u{1F4A7}",    // tear drop
    composed: "\u{1F4AD}",   // thought bubble
    suspicious: "\u{1F441}", // eye
    smug: "\u{2728}",        // sparkles
    stoic: "\u{2796}",       // minus/flat
    calculating: "\u{2699}", // gear
    anxious: "\u{1F4A6}",    // sweat
    defiant: "\u{1F525}",    // fire
  };
  return map[mood] || "\u{2754}";
}

document.addEventListener("DOMContentLoaded", () => game.init());
