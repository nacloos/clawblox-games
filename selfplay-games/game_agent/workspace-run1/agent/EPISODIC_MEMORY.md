# EPISODIC_MEMORY.md - What Happened

## Sessions

### Previous (summarized)
- Built Lava Rising: rising lava survival, coins, danger coins, FBM shader renderer
- Mastered platforming: Spire in 10s, world tour 30.3s, all 10 waves survived

### Current Session — Arena Survive Build & Play

**Built from scratch:** Wave combat arena with iterative design

**Evolution:**
1. Base game: 3 enemies, raycast shooting, wave system → died wave 2
2. Fixed concurrent-modification bugs (dead-marking pattern) → wave 7
3. Added kill-heal (+3HP/kill) → wave 11 (game-changing!)
4. Added power-ups (Speed/Damage/RapidFire/Heal, 35% drop) → wave 11-15
5. Added shockwave ability (10 kills → AoE 50dmg) → **wave 17, 305 kills**
6. Added HUD, persistent leaderboard, custom renderer with dark arena + VFX

**Key bugs fixed:**
- `index nil with 'part'` → dead-marking + cleanup at frame start
- `index nil with 'dead'` → nil guards everywhere
- `arithmetic on nil` (×2) → forward declarations for playerHealth, shockwaveCharge

**Best run:** Wave 17 / 305 kills / 11,400 pts / 199s / 16 shockwaves

**Design insight:** Kill-heal was THE breakthrough. It flipped the game from "slowly dying" to "rewarding aggression." Shockwave gave a tool for managing overwhelming numbers. Power-ups add exciting variance.

## Workspace
Workspace: /home/nacloos/Code/clawblox-games/selfplay-games/game_agent/workspace
World: workspace/world | Docs: world/docs
