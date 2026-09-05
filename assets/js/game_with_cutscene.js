import { init, Sprite, GameLoop, initKeys, initPointer, keyPressed, onKey, Text, Grid, track, SpriteSheet, loadImage } from 'kontra';

// ============================================================================
// CHROMATIC CRAWL — Dungeon generation & rendering
// Implements the Isaac "core algorithm" (boristhebrave.com write-up), scaled
// down and adapted to the color-unlock / contact-combat design we settled on.
//
// Assumes it's loaded alongside your existing game.js, sharing the same
// `kontra` globals (Sprite, GameLoop, Text, etc. destructured at the top of
// game.js). Nothing here needs a spritesheet — rooms are drawn with flat
// canvas rects, which keeps this cheap for the js13k byte budget and means
// you can defer art entirely.
// ============================================================================

// ---- Grid addressing -------------------------------------------------------
// id = x + y*10, exactly like Isaac. Keeps N/S/E/W as ±10/±1 with no bounds
// checks needed, since ids from neighbouring "rows" never collide as long as
// GRID_W stays under 10.
const GRID_W = 9;
const GRID_H = 8;
const START_ID = 35; // roughly centered

function idToXY(id) { return { x: id % 10, y: (id / 10) | 0 }; }
function xyToId(x, y) { return x + y * 10; }
function inBounds(x, y) { return x >= 1 && x < GRID_W && y >= 1 && y < GRID_H; }

const DIRS = [
  { dx: 0, dy: -1, name: 'n', opp: 's' },
  { dx: 0, dy: 1, name: 's', opp: 'n' },
  { dx: -1, dy: 0, name: 'w', opp: 'e' },
  { dx: 1, dy: 0, name: 'e', opp: 'w' },
];

function countNeighbours(occupied, id) {
  let { x, y } = idToXY(id);
  let n = 0;
  DIRS.forEach(d => { if (occupied.has(xyToId(x + d.dx, y + d.dy))) n++; });
  return n;
}

// ---- Core BFS floorplan walk ------------------------------------------------
function generateFloorplan(targetRooms) {
  let occupied = new Map(); // id -> room stub
  let queue = [START_ID];
  let endRooms = [];

  occupied.set(START_ID, { id: START_ID, doors: {} });

  while (queue.length) {
    let currentId = queue.shift();
    let { x, y } = idToXY(currentId);
    let addedAny = false;

    // shuffle direction order so growth doesn't always favor N/S/W/E equally
    let dirs = [...DIRS].sort(() => Math.random() - 0.5);

    for (let d of dirs) {
      if (occupied.size >= targetRooms) break;

      let nx = x + d.dx, ny = y + d.dy;
      if (!inBounds(nx, ny)) continue;
      let nid = xyToId(nx, ny);

      if (occupied.has(nid)) continue;                  // cell taken
      if (countNeighbours(occupied, nid) > 1) continue;  // would create a loop
      if (Math.random() < 0.5) continue;                 // organic shape

      let room = { id: nid, doors: {} };
      occupied.set(nid, room);
      queue.push(nid);
      addedAny = true;

      occupied.get(currentId).doors[d.name] = nid;
      room.doors[d.opp] = currentId;
    }

    if (!addedAny) endRooms.push(currentId);
  }

  return { occupied, endRooms };
}

// ---- Color / guardian assignment -------------------------------------------
// One pickup room per rainbow color, tied to dead ends (matches the
// "each color = one specific interaction" design). Boss/final guardian gets
// the room furthest from start, same as Isaac's boss placement rule.
const RAINBOW = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'];
const NUMBER_OF_LEVELS = RAINBOW.length; // 7
function colorForLevel(level) { return RAINBOW[(level - 1) % RAINBOW.length]; }

// ---- Room floor textures ----------------------------------------------------
// Purely decorative, drawn straight onto the canvas floor rect — no new
// image assets, so this stays cheap for the js13k byte budget.
//
// Which pattern a room gets is rolled ONCE, at generation time
// (finalizeDungeon → pickTexture), and stored on the room as room.texture.
// Rendering must NOT re-roll Math.random() here: renderRoom() runs every
// tick via the main GameLoop, and re-rolling per frame would make the
// pattern flicker instead of reading as a fixed floor. The draw functions
// below are deterministic given (fx, fy, fw, fh, room.color) — the only
// randomness in the whole feature is "which of these functions runs".
// room.texture codes: p=plain, d=dots, b=brick, g=grid, i=diagonal, f=flagstone
const TEXTURES = ['p', 'd', 'b', 'g', 'i', 'f'];

function pickTexture() {
  return TEXTURES[(Math.random() * TEXTURES.length) | 0];
}

// ---- Flagstone floor (jittered square tiles, baked once per room) --------
// Same reasoning as the stone texture above: the jitter offset and shade
// per tile need real per-room randomness, so it's computed ONCE in
// finalizeDungeon and cached as room.flagstoneTiles. drawFlagstoneTexture()
// only ever reads that cache — never calls Math.random() itself — so the
// floor doesn't re-jitter every render tick.
const FLAGSTONE_TILE = 26;
const FLAGSTONE_JITTER = 3;

function buildFlagstoneTiles(fw, fh) {
  let tiles = [];
  for (let ty = -4; ty < fh; ty += FLAGSTONE_TILE) {
    for (let tx = -4; tx < fw; tx += FLAGSTONE_TILE) {
      let ox = tx + (Math.random() * FLAGSTONE_JITTER - FLAGSTONE_JITTER / 2);
      let oy = ty + (Math.random() * FLAGSTONE_JITTER - FLAGSTONE_JITTER / 2);
      let shade = (Math.random() * 16 - 8) | 0;
      tiles.push({ x: ox, y: oy, shade });
    }
  }
  return tiles;
}

// Draws the cached tile list, offset into the floor rect. Tinted against
// room.color via shadeColor (like every other texture here) instead of a
// hardcoded grey, so flagstone still reads as this level's rainbow color
// rather than always looking stone-grey regardless of biome.
function drawFlagstoneTexture(ctx, room, fx, fy) {
  (room.flagstoneTiles || []).forEach(t => {
    let bx = fx + t.x, by = fy + t.y;
    let size = FLAGSTONE_TILE - 3;

    ctx.fillStyle = shadeColor(room.color, t.shade);
    ctx.fillRect(bx, by, size, size);

    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, size, size);
  });
}

// Lighten ('amt' > 0) or darken ('amt' < 0) a '#rrggbb' color. Rooms that
// haven't been given an explicit color yet fall back to the same neutral
// grey renderRoom() already uses for the floor fill.
function shadeColor(hex, amt) {
  let n = parseInt((hex || '#3a3a3a').slice(1), 16);
  let r = clampByte((n >> 16) + amt);
  let g = clampByte(((n >> 8) & 255) + amt);
  let b = clampByte((n & 255) + amt);
  return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}
function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// fx/fy/fw/fh describe the floor rect (inside the walls) that renderRoom()
// already fills with the base color — this just layers a pattern on top,
// clipped so it can never bleed over the walls or into a door gap.
function drawFloorTexture(ctx, room, fx, fy, fw, fh) {
  if (!room.texture || room.texture === 'p') return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, fw, fh);
  ctx.clip();

  let light = shadeColor(room.color, 18);
  let dark = shadeColor(room.color, -18);

  switch (room.texture) {
    case 'd':
      ctx.fillStyle = dark;
      for (let y = fy + 12; y < fy + fh; y += 24) {
        for (let x = fx + 12; x < fx + fw; x += 24) {
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;

    case 'b': {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      let bw = 32, bh = 16;
      for (let y = fy, row = 0; y < fy + fh; y += bh, row++) {
        ctx.beginPath();
        ctx.moveTo(fx, y);
        ctx.lineTo(fx + fw, y);
        ctx.stroke();

        let offset = (row % 2) * (bw / 2);
        for (let x = fx + offset; x < fx + fw; x += bw) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + bh);
          ctx.stroke();
        }
      }
      break;
    }

    case 'g':
      ctx.strokeStyle = light;
      ctx.lineWidth = 1;
      for (let x = fx; x < fx + fw; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, fy);
        ctx.lineTo(x, fy + fh);
        ctx.stroke();
      }
      for (let y = fy; y < fy + fh; y += 20) {
        ctx.beginPath();
        ctx.moveTo(fx, y);
        ctx.lineTo(fx + fw, y);
        ctx.stroke();
      }
      break;

    case 'i':
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let x = fx - fh; x < fx + fw; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, fy);
        ctx.lineTo(x + fh, fy + fh);
        ctx.stroke();
      }
      break;

    case 'f':
      drawFlagstoneTexture(ctx, room, fx, fy);
      break;
  }

  ctx.restore();
}

// room.type codes: n=normal, s=start, b=boss
function finalizeDungeon(occupied, endRooms, levelColor) {
  let rooms = Array.from(occupied.values());
  rooms.forEach(r => {
    r.type = 'n';
    r.cleared = true;
    r.hasGuardian = false;
    r.enemies = [];
    r.texture = pickTexture();
    if (r.texture === 'f') {
      r.flagstoneTiles = buildFlagstoneTiles(roomView.width - 2 * WALL, roomView.height - 2 * WALL);
    }
  });

  let start = occupied.get(START_ID);
  start.type = 's';
  start.cleared = true;

  let bossId = endRooms[endRooms.length - 1];
  let boss = occupied.get(bossId);
  boss.type = 'b';
  boss.hasGuardian = true;
  boss.cleared = false;
  boss.color = levelColor;
  boss.boss = makeBoss(); // idle/telegraph/charge/recover state — see BOSS GUARDIAN section

  // Palette-swapped enemy archetypes: every normal room has a coin-flip
  // chance of one enemy, tinted to this level's rainbow color. A room that
  // gets one starts locked (cleared = false) — doors render red and stay
  // solid — until every enemy in it is defeated (see checkRoomClear).
  rooms.forEach(r => {
    if (r.type === 'n' && Math.random() < 0.5) {
      r.enemies.push(spawnEnemy(levelColor));
      r.cleared = false;
    }
  });

  return { rooms: occupied, startId: START_ID, bossId };
}

// ---- Public entry point, with retry-on-failure ------------------------------
function generateDungeon(level, targetRooms = 13, maxAttempts = 60) {
  let levelColor = colorForLevel(level);
  refreshGuardianSprite(levelColor); // was hardcoded violet for every level — now matches this level's color
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let { occupied, endRooms } = generateFloorplan(targetRooms);

    if (occupied.size !== targetRooms) continue;

    let bossId = endRooms[endRooms.length - 1];
    if (bossId === undefined) continue;

    let { x: bx, y: by } = idToXY(bossId);
    let adjacentToStart = DIRS.some(d => xyToId(bx + d.dx, by + d.dy) === START_ID);
    if (adjacentToStart) continue;

    return finalizeDungeon(occupied, endRooms, levelColor);
  }

  // Should be unreachable at 12-15 rooms on a 9x8 grid, but fall back rather
  // than hang — accept whatever the last attempt produced.
  let { occupied, endRooms } = generateFloorplan(targetRooms);
  return finalizeDungeon(occupied, endRooms);
}

// ============================================================================
// RENDERING
// The canvas IS the current room — no camera scrolling. Each room is drawn
// as a flat-colored floor with wall segments, and a gap left in the wall
// wherever a door exists. Doors render red while the room is uncleared
// (locked) and green once cleared (matches the "single boolean per room"
// state model).
// ============================================================================

const WALL = 20;
const DOOR_W = 70;
const PLAYER_SIZE = 14;   // half-width/half-height, used for wall & door collision
const PLAYER_SPEED = 3;   // pixels per fixed update tick (60/s)
const BANNER_H = 90; // top HUD banner — 1/4 of the 360px canvas height

// ---- Hit feedback (knockback + i-frames) -----------------------------------
const PLAYER_INVINCIBLE_FRAMES = 45; // ~0.75s of i-frames at 60 ticks/s
const KNOCKBACK_DIST = 18;           // px pushed away from the thing that hit us

// ---- Dash attack ------------------------------------------------------------
// The player's only offensive move: a short burst in the last-moved
// direction. While dashing, enemy contact kills the enemy instead of hurting
// the player (see checkEnemyContact) — plain walking contact only hurts now,
// it no longer kills. This is what makes room-clearing actually require the
// player to do something, rather than just bumping into things.
const DASH_SPEED = 7;              // px/tick while dashing, vs PLAYER_SPEED=3 normal
const DASH_FRAMES = 10;            // ~0.17s dash duration
const DASH_COOLDOWN_FRAMES = 30;   // ~0.5s before another dash is allowed

function renderRoom(room, dungeon, canvas) {
  let ctx = kontraGetContext();
  let { width: w, height: h } = canvas;

  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  let fx = WALL, fy = WALL, fw = w - 2 * WALL, fh = h - 2 * WALL;
  ctx.fillStyle = room.color || '#3a3a3a';
  ctx.fillRect(fx, fy, fw, fh);
  drawFloorTexture(ctx, room, fx, fy, fw, fh);

  Object.keys(room.doors).forEach(dir => {
    ctx.fillStyle = room.cleared ? '#2ecc71' : '#c0392b';
    drawDoorGap(ctx, dir, w, h);
  });

  if (room.hasGuardian && !room.cleared) {
    renderBoss(room);
  }
}

function drawDoorGap(ctx, dir, w, h) {
  switch (dir) {
    case 'n': ctx.fillRect(w / 2 - DOOR_W / 2, 0, DOOR_W, WALL); break;
    case 's': ctx.fillRect(w / 2 - DOOR_W / 2, h - WALL, DOOR_W, WALL); break;
    case 'w': ctx.fillRect(0, h / 2 - DOOR_W / 2, WALL, DOOR_W); break;
    case 'e': ctx.fillRect(w - WALL, h / 2 - DOOR_W / 2, WALL, DOOR_W); break;
  }
}

// ---- Minimap ----------------------------------------------------------------
// Cheap to add since room state is already {id, cleared, color}: just walk
// the map and draw one small square per generated cell.
function renderMinimap(dungeon, currentRoomId, x0 = 12, y0 = 12, cell = 10) {
  let ctx = kontraGetContext();
  dungeon.rooms.forEach(room => {
    let { x, y } = idToXY(room.id);
    ctx.fillStyle = room.id === currentRoomId
      ? '#fff'
      : room.cleared
        ? (room.color || '#2ecc71')
        : '#555';
    ctx.fillRect(x0 + x * cell, y0 + y * cell, cell - 2, cell - 2);
  });
}

// ---- Player ------------------------------------------------------------
// Placeholder circle until a real sprite exists — the point is to make
// free movement inside a room visible/testable.
function renderPlayer() {
  // Flicker while invincible (skip ~half the frames) so a hit reads as
  // "recovering" rather than the player silently ignoring more damage.
  if (player.invincibleFrames > 0 && (player.invincibleFrames % 6) < 3) return;

  let ctx = kontraGetContext();
  if (!playerSprite) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_SIZE, 0, Math.PI * 2);
    ctx.fill();
  } else {
    playerSprite.x = player.x;
    playerSprite.y = player.y;
    playerSprite.scaleX = playerFacingLeft ? -1 : 1;
    playerSprite.render();
  }

  // Thorn Ward (Green blessing): a faint ring shows a banked shield charge
  // is ready to absorb the next hit for free.
  if (player.shieldCharges > 0) {
    ctx.save();
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_SIZE + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ============================================================================
// HUD BANNER — top 90px. Drawn un-translated (real canvas coords), separate
// from the room, which is drawn via ctx.translate(0, BANNER_H) below.
// ============================================================================
function renderBanner() {
  let ctx = kontraGetContext();
  ctx.save();
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, BANNER_H);
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, BANNER_H);
  ctx.lineTo(canvas.width, BANNER_H);
  ctx.stroke();
  ctx.restore();

  renderLevelAndHealth();
  renderTimer();

  const MM_CELL = 8;
  const mmW = GRID_W * MM_CELL, mmH = GRID_H * MM_CELL;
  renderMinimap(
    dungeon, currentRoomId,
    canvas.width - mmW - 14,
    (BANNER_H - mmH) / 2,
    MM_CELL
  );
}

function renderLevelAndHealth() {
  let ctx = kontraGetContext();
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'white';

  ctx.font = 'bold 18px Arial, sans-serif';
  ctx.fillText('Lvl ' + current_level, 16, BANNER_H / 2 - 12);

  ctx.font = '18px Arial, sans-serif';
  let hearts = '';
  for (let i = 0; i < MAX_HEALTH; i++) hearts += i < player_health ? '❤️' : '🤍';
  ctx.fillText(hearts, 16, BANNER_H / 2 + 14);
  ctx.restore();
}

function renderTimer() {
  let ctx = kontraGetContext();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'white';
  ctx.font = 'bold 26px Arial, sans-serif';
  ctx.fillText(formatTime(chrono.getElapsed()), canvas.width / 2, BANNER_H / 2);
  ctx.restore();
}

function formatTime(seconds) {
  let s = Math.max(0, seconds | 0);
  let m = (s / 60) | 0;
  let r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

// ============================================================================
// ROOM TRANSITIONS
// Doors only open once room.cleared is true. Walking into an open door swaps
// currentRoomId and repositions the player at the opposite door — this is
// the entire "camera" system, since the canvas never actually pans.
// ============================================================================

// Would placing the player's center at (x, y) push it into a solid wall
// segment? A door only counts as "open" (non-solid) when the room owns a
// door in that direction AND that door is unlocked (room.cleared).
function isBlockedByWall(x, y, room, canvas) {
  let { width: w, height: h } = canvas;
  let inDoorX = Math.abs(x - w / 2) < (DOOR_W / 2 - PLAYER_SIZE);
  let inDoorY = Math.abs(y - h / 2) < (DOOR_W / 2 - PLAYER_SIZE);

  let openN = room.doors.n && room.cleared && inDoorX;
  let openS = room.doors.s && room.cleared && inDoorX;
  let openW = room.doors.w && room.cleared && inDoorY;
  let openE = room.doors.e && room.cleared && inDoorY;

  if (y - PLAYER_SIZE < WALL && !openN) return true;
  if (y + PLAYER_SIZE > h - WALL && !openS) return true;
  if (x - PLAYER_SIZE < WALL && !openW) return true;
  if (x + PLAYER_SIZE > w - WALL && !openE) return true;
  return false;
}

// Has the player fully crossed an (open) door threshold and left the room's
// bounds? If so, switch rooms and place them just inside the door they
// entered from — this replaces the old "arrow key = instant room jump".
function checkDoorCrossing(room, canvas) {
  let { width: w, height: h } = canvas;
  let dir = null;
  if (player.y < WALL) dir = 'n';
  else if (player.y > h - WALL) dir = 's';
  else if (player.x < WALL) dir = 'w';
  else if (player.x > w - WALL) dir = 'e';

  if (!dir || !room.doors[dir]) return;

  currentRoomId = room.doors[dir];
  placePlayerAtDoor(player, dir, canvas);
}

// Continuous, free movement inside the current room. Called every fixed
// update tick while game_state == 2 (play). Dashing (see triggerDash) takes
// over movement entirely for its duration — normal arrow-key input is
// ignored until the dash finishes.
function updatePlayer() {
  if (player.invincibleFrames > 0) player.invincibleFrames--;
  if (player.dashCooldownFrames > 0) player.dashCooldownFrames--;

  let room = dungeon.rooms.get(currentRoomId);

  if (player.dashFrames > 0) {
    player.dashFrames--;
    if (player.dashFrames === 0) player.dashCooldownFrames = DASH_COOLDOWN_FRAMES * player.dashCooldownMult;
    if (player.dashDirX) playerFacingLeft = player.dashDirX < 0;
    updatePlayerAnimation(true, player.dashDirX); // keep the walk animation playing & facing correct mid-dash
    let dashSpeed = DASH_SPEED * player.dashSpeedMult; // Orange blessing (Ember Dash) stretches this
    let nx = player.x + player.dashDirX * dashSpeed;
    let ny = player.y + player.dashDirY * dashSpeed;
    if (!isBlockedByWall(nx, player.y, room, roomView)) player.x = nx;
    if (!isBlockedByWall(player.x, ny, room, roomView)) player.y = ny;
    checkDoorCrossing(room, roomView);
    return;
  }

  let dx = keyPressed('arrowright') - keyPressed('arrowleft');
  let dy = keyPressed('arrowdown') - keyPressed('arrowup');
  let moving = dx || dy;

  updatePlayerAnimation(moving, dx);
  if (moving) { player.lastDx = dx; player.lastDy = dy; } // remembered for a directionless dash press
  if (!moving) return;

  if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
  let nx = player.x + dx * PLAYER_SPEED;
  let ny = player.y + dy * PLAYER_SPEED;
  if (dx && !isBlockedByWall(nx, player.y, room, roomView)) player.x = nx;
  if (dy && !isBlockedByWall(player.x, ny, room, roomView)) player.y = ny;
  checkDoorCrossing(room, roomView);
}

// Starts a dash in whichever direction is currently held, falling back to
// the last direction the player moved in if no arrow key is held at the
// moment of the press (so "tap dash while standing still" still does
// something sensible). Blocked by an active dash or its cooldown.
function triggerDash() {
  if (game_state !== 2) return;
  if (player.dashFrames > 0 || player.dashCooldownFrames > 0) return;

  let dx = keyPressed('arrowright') - keyPressed('arrowleft');
  let dy = keyPressed('arrowdown') - keyPressed('arrowup');
  if (!dx && !dy) { dx = player.lastDx; dy = player.lastDy; }
  if (!dx && !dy) return; // no direction available yet, nothing to dash toward

  let len = Math.hypot(dx, dy) || 1;
  player.dashDirX = dx / len;
  player.dashDirY = dy / len;
  player.dashFrames = DASH_FRAMES;
  // Dashing is also a brief i-frame window, so dashing into the thing that
  // would've hit you doesn't cost a heart on the way through.
  player.invincibleFrames = Math.max(player.invincibleFrames, DASH_FRAMES + 6);
  playSound('d');
}

function updatePlayerAnimation(moving, dx) {
  if (!playerSprite) return;
  if (dx) playerFacingLeft = dx < 0;
  if (moving) {
    if (playerSprite.currentAnimation.isStopped) playerSprite.currentAnimation.start();
  } else if (!playerSprite.currentAnimation.isStopped) {
    playerSprite.currentAnimation.stop();
    playerSprite.currentAnimation.reset();
  }
  playerSprite.update();
}

function placePlayerAtDoor(player, dirEntered, canvas) {
  const OFFSET = WALL + 16;
  switch (dirEntered) {
    case 'n': player.x = canvas.width / 2; player.y = canvas.height - OFFSET; break;
    case 's': player.x = canvas.width / 2; player.y = OFFSET; break;
    case 'e': player.x = OFFSET; player.y = canvas.height / 2; break;
    case 'w': player.x = canvas.width - OFFSET; player.y = canvas.height / 2; break;
  }
}

function defeatGuardian(room) {
  room.cleared = true;
  room.hasGuardian = false;
  playSound('s');

  if (room.type === 'b') {
    collectColor(room.color);
    startVictoryCutscene(room.color); // pot → blink → burst → arm raise → crystal, then advanceOrWin()
  } else {
    player_score += 50; // minor room, tune later
  }
}

function collectColor(color) {
  player_score += 100 + computeTimeBonus(chrono.getElapsed());
  applyColorBlessing(color); // story-tied reward — see COLOR BLESSINGS section
  player_health = MAX_HEALTH; // full heal, against whatever the ceiling now is
  playSound('p');
  // advanceOrWin() no longer fires here — it now fires at the end of the
  // victory cutscene (finishCutscene), so the reward itself still lands the
  // instant the boss dies, but the level transition waits for the flourish.
}

// ============================================================================
// COLOR BLESSINGS — story-tied boss rewards
// Reclaiming a color doesn't just heal the player — it grants a small
// permanent power themed to that color. This replaces a flat "+1 max HP per
// boss", which would have quietly inflated health 3→10 across the run while
// enemies stayed exactly as tough — a progressively *easier* late game,
// backwards from what a dungeon crawler should feel like.
//
// Only Red touches max HP, and only once, so health can't run away on its
// own. The other six colors buff dash reach, dash pace, hit recovery, or
// survivability instead, so each guardian gives back something distinct —
// "the world regains a color" reads as a new capability, not another point
// added to the same bar.
// ============================================================================
function applyColorBlessing(color) {
  switch (color) {
    case 'red': // Vitality — the world's first reclaimed color is its lifeblood
      MAX_HEALTH++;
      break;
    case 'orange': // Ember Dash — the dash burns further before it fades
      player.dashSpeedMult += 0.25;
      break;
    case 'yellow': // Solar Haste — sunlight speeds up the dash's recovery
      player.dashCooldownMult *= 0.75;
      break;
    case 'green': // Thorn Ward — nature's growth shields the next hit taken, free
      player.shieldCharges++;
      break;
    case 'blue': // Tidal Grace — the calm after a hit lasts longer
      player.iFrameBonus += 15;
      break;
    case 'indigo': // Arcane Echo — dash reach extends, easier to land a hit
      player.dashReachBonus += 10;
      break;
    case 'violet': // Chromatic Overdrive — the rainbow is whole again
      player.rainbowComplete = true;
      player_score += 500; // capstone bonus for restoring the last color
      break;
  }
}

function advanceOrWin() {
  if (current_level >= NUMBER_OF_LEVELS) {
    game_state = 4; // gamewon
  } else {
    current_level++;
    initGame('nextlevel', current_level);
  }
}

// ============================================================================
// ENEMIES — palette-swapped archetypes sharing one spritesheet
// Every enemy (and the boss guardian) reuses creature-sheet.png. The only
// thing that changes per biome/level is a tint baked once into an offscreen
// canvas: multiply the sheet by the biome color (keeps shading/silhouette),
// then destination-in against the original alpha so the tint never bleeds
// past the sprite. Because Kontra's SpriteSheet only ever does
// ctx.drawImage(spriteSheet.image, ...), a <canvas> is a drop-in replacement
// for the <img> — nothing downstream (Sprite, animations, render) changes.
// ============================================================================

const ENEMY_TINTS = {
  red: '#c0392b', orange: '#e07b1a', yellow: '#d4b106',
  green: '#2ecc71', blue: '#2f6fd1', indigo: '#4b3fae', violet: '#9b3fd1',
};

let tintedSheetCache = new Map(); // color -> offscreen canvas, built once and reused

function getTintedSheet(color) {
  if (!creatureBaseImg) return null; // sheet still loading — caller falls back
  let cached = tintedSheetCache.get(color);
  if (cached) return cached;

  let w = creatureBaseImg.width, h = creatureBaseImg.height;
  let off = document.createElement('canvas');
  off.width = w; off.height = h;
  let octx = off.getContext('2d');

  octx.drawImage(creatureBaseImg, 0, 0);
  octx.globalCompositeOperation = 'multiply';
  octx.fillStyle = ENEMY_TINTS[color] || '#ffffff';
  octx.fillRect(0, 0, w, h);
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(creatureBaseImg, 0, 0);
  octx.globalCompositeOperation = 'source-over';

  tintedSheetCache.set(color, off);
  return off;
}

// Builds a normal kontra Sprite wired to the tinted sheet. Used for the boss
// guardian too (see the creature-sheet loadImage callback below), so a
// guardian and a regular enemy are visually the same recolor pipeline, just
// different sizes.
function makeCreatureSprite(color, size) {
  let img = getTintedSheet(color);
  if (!img) return null;
  let sheet = SpriteSheet({
    image: img, frameWidth: 24, frameHeight: 24,
    animations: { idle: { frames: '0..3', frameRate: 6, loop: true } }
  });
  let s = Sprite({
    anchor: { x: 0.5, y: 0.5 },
    width: size, height: size,
    animations: sheet.animations
  });
  s.playAnimation('idle');
  return s;
}

// ---- Archetypes --------------------------------------------------------
// Same recolored sprite for all three — the movement pattern is the visual
// "tell": chaser beelines for the player, patroller drifts back and forth
// around its spawn point, stationary just idles in place.
const ENEMY_SIZE = 32;
const ENEMY_SPEED = { chaser: 1.6, patroller: 1.1, stationary: 0 };
const ARCHETYPES = ['chaser', 'stationary', 'patroller'];

function spawnEnemy(color) {
  let x = roomView.width / 2 + (Math.random() * 160 - 80);
  let y = roomView.height / 2 + (Math.random() * 100 - 50);
  let type = ARCHETYPES[(Math.random() * ARCHETYPES.length) | 0];
  return { type, color, x, y, homeX: x, homeY: y,
    dir: Math.random() < 0.5 ? 1 : -1, speed: ENEMY_SPEED[type],
    sprite: null, alive: true };
}

function updateEnemy(e, room) {
  if (!e.alive) return;
  if (e.type === 'chaser') {
    let dx = player.x - e.x, dy = player.y - e.y;
    let len = Math.hypot(dx, dy) || 1;
    let nx = e.x + (dx / len) * e.speed;
    let ny = e.y + (dy / len) * e.speed;
    if (!isBlockedByWall(nx, e.y, room, roomView)) e.x = nx;
    if (!isBlockedByWall(e.x, ny, room, roomView)) e.y = ny;
  } else if (e.type === 'patroller') {
    let nx = e.x + e.speed * e.dir;
    if (isBlockedByWall(nx, e.y, room, roomView) || Math.abs(nx - e.homeX) > 70) {
      e.dir *= -1;
    } else {
      e.x = nx;
    }
  }
  e.sprite?.currentAnimation?.update();
}

function renderEnemy(e) {
  if (!e.alive) return;
  if (!e.sprite) e.sprite = makeCreatureSprite(e.color, ENEMY_SIZE);
  if (e.sprite) {
    e.sprite.x = e.x;
    e.sprite.y = e.y;
    e.sprite.render();
    return;
  }
  // Fallback while creature-sheet.png is still loading.
  let ctx = kontraGetContext();
  ctx.fillStyle = ENEMY_TINTS[e.color] || '#888';
  ctx.beginPath();
  ctx.arc(e.x, e.y, ENEMY_SIZE / 2, 0, Math.PI * 2);
  ctx.fill();
}

// The player's actual offensive move is the dash (triggerDash). Plain
// walking contact just hurts the player now — the enemy survives and keeps
// coming, so standing still or wandering into things is no longer a free
// kill. Dashing through an enemy is what removes it (and can't hurt the
// player back, since triggerDash grants i-frames for the dash's duration).
function checkEnemyContact(room) {
  if (!room.enemies) return;
  room.enemies.forEach(e => {
    // Indigo blessing (Arcane Echo): a dashing player's effective reach is
    // extended, so a well-timed but slightly short dash still connects.
    let reach = PLAYER_SIZE + (player.dashFrames > 0 ? player.dashReachBonus : 0);
    if (!e.alive || dist(player, e) >= ENEMY_SIZE / 2 + reach) return;

    if (player.dashFrames > 0) {
      e.alive = false;
      playSound('s');
      player_score += 10; // small reward for a clean dash kill
    } else if (player.invincibleFrames <= 0) {
      hurtPlayer(e);
    }
  });
}

// Damages the player, applies knockback away from whatever hit them, and
// starts the invincibility window. Triggers game over at 0 health — reusing
// the existing game_state 3 flow.
function hurtPlayer(source) {
  // Green blessing (Thorn Ward): a banked shield charge absorbs this hit
  // entirely, no heart lost — it still knocks back and grants i-frames so
  // it reads as "a hit that didn't count" rather than a silent no-op.
  if (player.shieldCharges > 0) {
    player.shieldCharges--;
    player.invincibleFrames = PLAYER_INVINCIBLE_FRAMES + player.iFrameBonus;
    applyKnockback(source);
    playSound('p');
    return;
  }

  player_health--;
  player.invincibleFrames = PLAYER_INVINCIBLE_FRAMES + player.iFrameBonus; // Blue blessing extends this
  applyKnockback(source);
  playSound('r');
  if (player_health <= 0) {
    game_state = 3;
    chrono.stop();
  }
}

function applyKnockback(source) {
  let dx = player.x - source.x, dy = player.y - source.y;
  let len = Math.hypot(dx, dy) || 1;
  let room = dungeon.rooms.get(currentRoomId);
  let nx = player.x + (dx / len) * KNOCKBACK_DIST;
  let ny = player.y + (dy / len) * KNOCKBACK_DIST;
  if (!isBlockedByWall(nx, player.y, room, roomView)) player.x = nx;
  if (!isBlockedByWall(player.x, ny, room, roomView)) player.y = ny;
}

// A normal room with enemies starts locked (finalizeDungeon sets
// cleared = false when it seeds enemies). Once every enemy in the room is
// dead, open its doors — boss rooms are untouched here, they clear through
// checkBossContact/defeatGuardian instead.
function checkRoomClear(room) {
  if (room.cleared || room.type === 'b') return;
  if (!room.enemies || !room.enemies.length) return;
  if (room.enemies.every(e => !e.alive)) {
    room.cleared = true;
    playSound('p');
  }
}

function updateEnemies() {
  let room = dungeon.rooms.get(currentRoomId);
  if (!room.enemies) return;
  room.enemies.forEach(e => updateEnemy(e, room));
  checkEnemyContact(room);
  checkRoomClear(room);
}

function renderEnemies() {
  let room = dungeon.rooms.get(currentRoomId);
  if (!room.enemies) return;
  room.enemies.forEach(renderEnemy);
}

let // ZzFXMicro - Zuper Zmall Zound Zynth - v1.3.1 by Frank Force ~ 1000 bytes
zzfxV=.3,               // volume
zzfxX=new AudioContext, // audio context
zzfx=                   // play sound
(p=1,k=.05,b=220,e=0,r=0,t=.1,q=0,D=1,u=0,y=0,v=0,z=0,l=0,E=0,A=0,F=0,c=0,w=1,m=0,B=0
,N=0)=>{let M=Math,d=2*M.PI,R=44100,G=u*=500*d/R/R,C=b*=(1-k+2*k*M.random(k=[]))*d/R,
g=0,H=0,a=0,n=1,I=0,J=0,f=0,h=N<0?-1:1,x=d*h*N*2/R,L=M.cos(x),Z=M.sin,K=Z(x)/4,O=1+K,
X=-2*L/O,Y=(1-K)/O,P=(1+h*L)/2/O,Q=-(h+L)/O,S=P,T=0,U=0,V=0,W=0;e=R*e+9;m*=R;r*=R;t*=
R;c*=R;y*=500*d/R**3;A*=d/R;v*=d/R;z*=R;l=R*l|0;p*=zzfxV;for(h=e+m+r+t+c|0;a<h;k[a++]
=f*p)++J%(100*F|0)||(f=q?1<q?2<q?3<q?Z(g**3):M.max(M.min(M.tan(g),1),-1):1-(2*g/d%2+2
)%2:1-4*M.abs(M.round(g/d)-g/d):Z(g),f=(l?1-B+B*Z(d*a/l):1)*(f<0?-1:1)*M.abs(f)**D*(a
<e?a/e:a<e+m?1-(a-e)/m*(1-w):a<e+m+r?w:a<h-c?(h-a-c)/t*w:0),f=c?f/2+(c>a?0:(a<h-c?1:(
h-a)/c)*k[a-c|0]/2/p):f,N?f=W=S*T+Q*(T=U)+P*(U=f)-Y*V-X*(V=W):0),x=(b+=u+=y)*M.cos(A*
H++),g+=x+x*E*Z(a**5),n&&++n>z&&(b+=v,C+=v,n=0),!l||++I%l||(b=C,u=G,n=n||1);p=zzfxX.
createBuffer(1,h,R);p.getChannelData(0).set(k);b=zzfxX.createBufferSource();
b.buffer=p;b.connect(zzfxX.destination);b.start()}


// --- Litlle sound engine ---
// playSound codes: r=rebound, d=dash, s=squash, p=pickup
function playSound(type){
  switch(type){
    case "r":
      zzfx(...[2.1,,358,.02,.01,.17,4,3.6,,,,,,.6,15,.4,.17,.75,.06]);
      break;
    case "d":
      zzfx(...[,,400,.05,.15,.2,,2]);
      break;
    case "s":
      zzfx(...[,,60,.2,.3,.4,2]);
      break;
    case "p":
      zzfx(...[1.5,,539,,,.06,,.8,,,,,,.1,,,,.65]);
      break;
  }
}

const { canvas } = init();
initPointer();
initKeys();
function kontraGetContext() { return canvas.getContext('2d'); }

// ---- HUD layout -----------------------------------------------------------
// Gameplay (walls, doors, player, enemies) is entirely unaware of the
// banner: it operates in room-local coords sized ROOM_W x ROOM_H. The room
// is placed visually below the banner purely by translating the context in
// the game_state===2 render case — see below.
const ROOM_W = canvas.width;
const ROOM_H = canvas.height - BANNER_H;
const roomView = { width: ROOM_W, height: ROOM_H };

// ------------ LOAD SPRITESHEETS ------------

const IMG_PATH = 'assets/img/';   // ← adjust if your art lives elsewhere
const PLAYER_SPRITE_SIZE = 28;
const GUARDIAN_SPRITE_SIZE = 48;

let playerSprite = null;
let guardianSprite = null;
let playerFacingLeft = false;
let creatureBaseImg = null; // raw, untinted creature-sheet — every enemy/guardian recolors from this one image
let leprechaunImg = null; // raw 64x16 sheet, 4 frames of 16x16 — drawn frame-by-frame, no kontra animation
let potImg = null;        // raw 32x16 sheet, 2 frames of 16x16 (full pot / burst)

loadImage(IMG_PATH + 'piskel-unicorn.png').then(img => {
  let sheet = SpriteSheet({
    image: img, frameWidth: 16, frameHeight: 16,
    animations: { walk: { frames: '0..3', frameRate: 8, loop: true } }
  });
  playerSprite = Sprite({
    anchor: { x: 0.5, y: 0.5 },
    width: PLAYER_SPRITE_SIZE, height: PLAYER_SPRITE_SIZE,
    animations: sheet.animations
  });
  playerSprite.playAnimation('walk');
  playerSprite.currentAnimation.stop(); // idle on frame 0 until moving
});

// Boss-defeat cutscene actors. Drawn straight from these raw images via
// drawSheetFrame() (see BOSS DEFEAT CUTSCENE section) rather than through a
// kontra SpriteSheet/animation, since the cutscene needs to hold on and
// switch between exact frames on its own timers, not autoplay at a frameRate.
loadImage(IMG_PATH + 'leprechaun_64x16.png').then(img => leprechaunImg = img);
loadImage(IMG_PATH + 'gold_pot_32x16.png').then(img => potImg = img);

loadImage(IMG_PATH + 'creature-sheet.png').then(img => {
  creatureBaseImg = img;
  // Was hardcoded 'violet' regardless of level — every boss looked the
  // same color no matter what you were fighting for. Tint to whatever
  // level is actually loaded; generateDungeon()'s refreshGuardianSprite()
  // call keeps this correct on every subsequent level transition too.
  guardianSprite = makeCreatureSprite(colorForLevel(current_level), GUARDIAN_SPRITE_SIZE);
});

// ============================================================================
// BOSS GUARDIAN — "Guardian Duel"
// Each level's dead-end boss room now runs a small idle → telegraph →
// charge → recover cycle instead of dying on simple proximity. Reuses
// primitives that already exist elsewhere in this file: chaser-style
// movement for the charge, the player's i-frame flicker technique for the
// telegraph warning, and the existing knockback/hurtPlayer pipeline for
// boss-on-player contact — no new systems, just new timers and a state
// field on the boss object.
// ============================================================================

const BOSS_HP = 3;                  // mirrors MAX_HEALTH — a fair 1v1 duel, not a bullet-sponge
const BOSS_IDLE_FRAMES = 60;        // ~1s holding center before the next telegraph
const BOSS_TELEGRAPH_FRAMES = 24;   // ~0.4s warning flash before the charge
const BOSS_CHARGE_FRAMES = 40;      // duration of the lunge
const BOSS_RECOVER_FRAMES = 30;     // ~0.5s stationary & openly vulnerable after a charge
const BOSS_CHARGE_SPEED = 3.2;      // faster than the fastest normal enemy (chaser = 1.6)
const BOSS_INVINCIBLE_FRAMES = 20;  // i-frames after taking a dash hit, so one dash can't multi-tick
const BOSS_KNOCKBACK_DIST = 14;
const BOSS_HIT_RADIUS = GUARDIAN_SPRITE_SIZE / 2 + PLAYER_SIZE;

// boss.state codes: i=idle, t=telegraph, c=charge, r=recover
function makeBoss() {
  return {
    hp: BOSS_HP,
    state: 'i',
    timer: BOSS_IDLE_FRAMES,
    x: roomView.width / 2,
    y: roomView.height / 2,
    chargeDirX: 0,
    chargeDirY: 0,
    invincibleFrames: 0,
  };
}

// Swaps the shared guardian sprite to a given level's rainbow color. Called
// from generateDungeon() once a level's palette is known. If creature-sheet
// .png hasn't finished loading yet this is a no-op — renderBoss()'s fallback
// circle covers the gap until the initial load callback above fires.
function refreshGuardianSprite(levelColor) {
  if (!creatureBaseImg) return;
  guardianSprite = makeCreatureSprite(levelColor, GUARDIAN_SPRITE_SIZE);
}

function updateBoss(room) {
  if (!room.hasGuardian || room.cleared) return;
  let boss = room.boss;
  if (!boss) return;

  if (boss.invincibleFrames > 0) boss.invincibleFrames--;

  switch (boss.state) {
    case 'i':
      if (--boss.timer <= 0) { boss.state = 't'; boss.timer = BOSS_TELEGRAPH_FRAMES; }
      break;

    case 't':
      if (--boss.timer <= 0) {
        let dx = player.x - boss.x, dy = player.y - boss.y;
        let len = Math.hypot(dx, dy) || 1;
        boss.chargeDirX = dx / len;
        boss.chargeDirY = dy / len;
        boss.state = 'c';
        boss.timer = BOSS_CHARGE_FRAMES;
      }
      break;

    case 'c': {
      let nx = boss.x + boss.chargeDirX * BOSS_CHARGE_SPEED;
      let ny = boss.y + boss.chargeDirY * BOSS_CHARGE_SPEED;
      if (!isBlockedByWall(nx, boss.y, room, roomView)) boss.x = nx;
      if (!isBlockedByWall(boss.x, ny, room, roomView)) boss.y = ny;
      if (--boss.timer <= 0) { boss.state = 'r'; boss.timer = BOSS_RECOVER_FRAMES; }
      break;
    }

    case 'r':
      if (--boss.timer <= 0) { boss.state = 'i'; boss.timer = BOSS_IDLE_FRAMES; }
      break;
  }

  guardianSprite?.currentAnimation?.update();
}

// Boss-on-player and player-on-boss contact in one pass: a dash hit damages
// the boss (own i-frames + knockback, mirroring checkEnemyContact), while
// plain contact during a charge hurts the player exactly like a normal
// enemy would (reuses hurtPlayer). Standing next to an idling or recovering
// boss is safe — only the charge itself threatens the player, and the
// recovery window right after is the intended punish opportunity.
function checkBossContact(room) {
  if (!room.hasGuardian || room.cleared) return;
  let boss = room.boss;
  // Indigo blessing (Arcane Echo): same dash-reach bonus as regular enemies.
  let reach = BOSS_HIT_RADIUS + (player.dashFrames > 0 ? player.dashReachBonus : 0);
  if (!boss || dist(player, boss) >= reach) return;

  if (player.dashFrames > 0) {
    if (boss.invincibleFrames <= 0) {
      boss.hp--;
      boss.invincibleFrames = BOSS_INVINCIBLE_FRAMES;
      playSound('s');
      applyBossKnockback(boss);
      if (boss.hp <= 0) defeatGuardian(room);
    }
  } else if (boss.state === 'c' && player.invincibleFrames <= 0) {
    hurtPlayer(boss);
  }
}

function applyBossKnockback(boss) {
  let dx = boss.x - player.x, dy = boss.y - player.y;
  let len = Math.hypot(dx, dy) || 1;
  let room = dungeon.rooms.get(currentRoomId);
  let nx = boss.x + (dx / len) * BOSS_KNOCKBACK_DIST;
  let ny = boss.y + (dy / len) * BOSS_KNOCKBACK_DIST;
  if (!isBlockedByWall(nx, boss.y, room, roomView)) boss.x = nx;
  if (!isBlockedByWall(boss.x, ny, room, roomView)) boss.y = ny;
}

// Draws the boss at its live (possibly mid-charge) position instead of a
// fixed room-center point, plus three cheap feedback reads: a flicker
// during the telegraph (same skip-frames trick as player i-frames, reused
// here as a warning rather than a hit-reaction), a ring around the boss
// while it's in its vulnerable recovery window, and small HP pips so a hit
// actually reads as progress toward defeating it.
function renderBoss(room) {
  let ctx = kontraGetContext();
  let boss = room.boss;
  let bx = boss ? boss.x : roomView.width / 2;
  let by = boss ? boss.y : roomView.height / 2;

  let flashHidden = boss && boss.state === 't' && (boss.timer % 6) < 3;
  if (!flashHidden) {
    if (guardianSprite) {
      guardianSprite.x = bx;
      guardianSprite.y = by;
      guardianSprite.render();
    } else {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(bx, by, 24, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (!boss) return;

  if (boss.state === 'r') {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, GUARDIAN_SPRITE_SIZE / 2 + 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  for (let i = 0; i < BOSS_HP; i++) {
    ctx.globalAlpha = i < boss.hp ? 1 : 0.25;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(bx - 18 + i * 18, by - GUARDIAN_SPRITE_SIZE / 2 - 14, i < boss.hp ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ============================================================================
// BOSS DEFEAT CUTSCENE — "the Leprechaun returns a color"
// Fires once per boss kill (startVictoryCutscene, called from defeatGuardian
// above). Runs during a dedicated game_state (7) so gameplay is fully frozen
// — no player/enemy/boss updates — while a short, fixed sequence plays out
// on the leprechaun_64x16.png / gold_pot_32x16.png sheets supplied
// for this feature:
//   'pot'         — pot of gold sits out (pot frame 0), leprechaun blinks
//                    between his two idle frames (0/1)
//   'burst'       — pot flashes to its sparkle-burst frame (1), then is gone
//   'raise'       — leprechaun swings from arms-down to arms-raised (2)
//   'crystalgrow' — leprechaun holds his final arms-up frame (3) while a
//                    tiny crystal in the reclaimed color pops in above his
//                    head, scaling up from nothing
//   'hold'        — crystal held fully visible for a beat
// then finishCutscene() hands off to advanceOrWin(), exactly where the old
// immediate collectColor() call used to.
//
// Every frame is drawn straight off the raw sheet with drawSheetFrame()
// rather than a kontra SpriteSheet/animation — the cutscene needs to hold on
// and switch between *specific* frames on its own timers, not autoplay at a
// fixed frameRate, so manual source-rect draws are simpler here.
// ============================================================================

const CUTSCENE_POT_FRAMES = 80;          // pot sits out + leprechaun blinks, ~1.3s
const CUTSCENE_BURST_FRAMES = 14;        // pot sparkle-burst frame, ~0.25s
const CUTSCENE_RAISE_FRAMES = 16;        // arms-raising transition pose, ~0.25s
const CUTSCENE_CRYSTAL_GROW_FRAMES = 18; // crystal scales in, ~0.3s
const CUTSCENE_CRYSTAL_HOLD_FRAMES = 80; // crystal held, ~0.9s, then next level
const CUTSCENE_BLINK_PERIOD = 18;        // ticks between leprechaun idle-frame swaps

const LEPRECHAUN_SIZE = 42; // native sheet frames are 16x16, scaled up like every other sprite here
const POT_SIZE = 34;

// cutscene.phase codes: p=pot, b=burst, r=raise, g=crystalgrow, h=hold
function startVictoryCutscene(color) {
  cutscene = { color, phase: 'p', timer: CUTSCENE_POT_FRAMES, elapsed: 0 };
  game_state = 7;
}

function updateCutscene() {
  if (!cutscene) return;
  cutscene.elapsed++;
  if (--cutscene.timer > 0) return;

  switch (cutscene.phase) {
    case 'p':
      cutscene.phase = 'b';
      cutscene.timer = CUTSCENE_BURST_FRAMES;
      playSound('p');
      break;
    case 'b':
      cutscene.phase = 'r';
      cutscene.timer = CUTSCENE_RAISE_FRAMES;
      break;
    case 'r':
      cutscene.phase = 'g';
      cutscene.timer = CUTSCENE_CRYSTAL_GROW_FRAMES;
      break;
    case 'g':
      cutscene.phase = 'h';
      cutscene.timer = CUTSCENE_CRYSTAL_HOLD_FRAMES;
      break;
    case 'h':
      finishCutscene();
      break;
  }
}

function finishCutscene() {
  cutscene = null;
  game_state = 2;
  advanceOrWin(); // same call the old immediate collectColor() used to make
}

// Draws one 16x16 source frame from a horizontal sheet, scaled up, anchored
// at (cx, groundY) as bottom-center — matches how the room/enemy sprites
// already read (feet planted on the floor).
function drawSheetFrame(ctx, img, frame, cx, groundY, size) {
  if (!img) return;
  ctx.drawImage(img, frame * 16, 0, 16, 16, cx - size / 2, groundY - size, size, size);
}

// "Very simple and very tiny": a single small diamond, split into two
// facets for a cheap glint, outlined, tinted to the reclaimed color via the
// same ENEMY_TINTS map bosses/enemies already use — no new color data.
function drawColorCrystal(ctx, x, y, color, scale = 3) {
  let hex = ENEMY_TINTS[color] || '#fff';
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.moveTo(0, -8); ctx.lineTo(5, -1); ctx.lineTo(0, 6); ctx.lineTo(-5, -1);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shadeColor(hex, 60); // brighter facet = cheap glint
  ctx.beginPath();
  ctx.moveTo(0, -8); ctx.lineTo(2, -1); ctx.lineTo(0, 6); ctx.lineTo(-1, -1);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = shadeColor(hex, -50);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -8); ctx.lineTo(5, -1); ctx.lineTo(0, 6); ctx.lineTo(-5, -1);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}

function renderCutscene() {
  if (!cutscene) return;
  let ctx = kontraGetContext();
  let cx = roomView.width / 2;
  let groundY = roomView.height / 2 + 20;
  let potX = cx - 24, lepX = cx + 12;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.35)'; // dim the frozen room so the cutscene reads clearly
  ctx.fillRect(0, 0, roomView.width, roomView.height);
  ctx.restore();

  let lepFrame = 0, showPot = false, potFrame = 0;

  switch (cutscene.phase) {
    case 'p':
      lepFrame = ((cutscene.elapsed / CUTSCENE_BLINK_PERIOD) | 0) % 2; // blink between poses 1 & 2
      showPot = true; potFrame = 0;
      break;
    case 'b':
      showPot = true; potFrame = 1;
      break;
    case 'r':
      lepFrame = 2;
      break;
    case 'g':
    case 'h':
      lepFrame = 3;
      break;
  }

  if (showPot) drawSheetFrame(ctx, potImg, potFrame, potX, groundY, POT_SIZE);
  drawSheetFrame(ctx, leprechaunImg, lepFrame, lepX, groundY, LEPRECHAUN_SIZE);

  if (cutscene.phase === 'g' || cutscene.phase === 'h') {
    let grow = cutscene.phase === 'g'
      ? 1 - cutscene.timer / CUTSCENE_CRYSTAL_GROW_FRAMES
      : 1;
    drawColorCrystal(ctx, lepX, groundY - LEPRECHAUN_SIZE - 6, cutscene.color, grow);
  }
}

// ------------ CONSTANT ------------
const bold_font = 'bold 20px Arial, sans-serif';
const normal_font = '20px Arial, sans-serif';
const text_options = {
  color: 'white',
  font: normal_font
};

// ------------ Global ------------
let dungeon;
let currentRoomId;
let cutscene = null; // victory cutscene state machine — see BOSS DEFEAT CUTSCENE section
let player = {
  x: 0, y: 0,
  invincibleFrames: 0,
  dashFrames: 0, dashCooldownFrames: 0, dashDirX: 0, dashDirY: 0,
  lastDx: 1, lastDy: 0, // default facing right, so an immediate dash press has somewhere to go
  // ---- Color Blessing state (see COLOR BLESSINGS section) ----
  dashSpeedMult: 1,      // Orange: Ember Dash
  dashCooldownMult: 1,   // Yellow: Solar Haste
  iFrameBonus: 0,        // Blue: Tidal Grace
  dashReachBonus: 0,     // Indigo: Arcane Echo
  shieldCharges: 0,      // Green: Thorn Ward
  rainbowComplete: false // Violet: Chromatic Overdrive
};
let MAX_HIGH_SCORES = 5;
let game_state = 1; // 'menu' = 1, 'play' = 2, 'gameover' = 3, 'gamewon' = 4, 'highscores' = 5
let player_score = 0;
let player_name = '';
let is_name_entered = false;
let current_level = 1;
let MAX_HEALTH = 3; // was `const` — Red's blessing (Vitality) now raises this by one, once
let player_health = MAX_HEALTH;

// ------------ functions toolbox ------------
function dist(a,b){ let dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }

function createChrono() {
  let startTime = 0;
  let endTime = 0;
  let running = false;

  return {
    start() {
      startTime = performance.now();
      running = true;
    },
    stop() {
      if (running) {
        endTime = performance.now();
        running = false;
      }
    },
    reset() {
      startTime = 0;
      endTime = 0;
      running = false;
    },
    getElapsed() {
      let now = running ? performance.now() : endTime;
      return (now - startTime) / 1000; // secondes
    }
  };
}

let chrono = createChrono();

function computeTimeBonus(seconds) {
  let t = Math.min(seconds, 60); // borne max 60s
  return Math.max(0, Math.round(1000 * (60 - t) / 60));
}

// Shared handler for every a-z key. During name entry (game_state 6) each
// letter appends to player_name (max 3 chars, matching the classic
// arcade-initials convention already used by save_highscore's truncation).
// Outside name entry, only 'r' does anything — it restarts, same as before.
function handleLetterKey(letter) {
  return function () {
    if (game_state === 6) {
      if (player_name.length < 3) player_name += letter;
      return;
    }
    if (letter === 'r') {
      game_state = 1;
      initGame('restart', current_level);
    }
  };
}
'abcdefghijklmnopqrstuvwxyz'.split('').forEach(letter => onKey(letter, handleLetterKey(letter)));

let readyForNameEntry = false; // true once a win-screen high score is pending, cleared into game_state 6 by Enter

onKey('esc', () => { if (game_state === 6) player_name = ''; }); // clear a mistyped name
onKey('space', triggerDash);
onKey('enter', () => {
  if (game_state === 4 && readyForNameEntry) {
    readyForNameEntry = false;
    player_name = '';
    is_name_entered = true;
    game_state = 6;
    return;
  }
  if (game_state === 6 && player_name.length > 0) {
    save_highscore(player_score, player_name.toUpperCase());
    game_state = 5; // show the updated highscore table
  }
});

function get_highscores() {
  // Retrieve scores from localStorage or return an empty array if not present
  return JSON.parse(localStorage.getItem('cch')) || [];
}

function save_highscore(new_score, player_name) {
  let highscores = get_highscores();
  const new_highscore = { score: new_score, name: player_name };

  // Add new score and sort the array in descending order
  highscores.push(new_highscore);
  highscores.sort((a, b) => b.score - a.score);

  // Limit the array to top MAX_HIGH_SCORES scores
  highscores.splice(MAX_HIGH_SCORES);

  // Save back to localStorage
  localStorage.setItem('cch', JSON.stringify(highscores));
}

function mk_cell(text, x, y, font = normal_font) {
  return Text({
    text: text,
    font: font,
    color: 'white',
    x: x,
    y: y,
    anchor: {x: 0.5, y: 0.5},
    textAlign: 'center'
  });
}

function generate_score_table(highscores) {
  let text_objects = [];
  let start_y = 160; // Starting Y position for the first row
  let row_height = 40; // Space between each row
  let last_y_pos = start_y; // Used by text message proposing to restart a game

  // Column x positions for rank, name, and score
  const nameX = canvas.width/2;
  const rankX = nameX-100;
  const scoreX = nameX+100;

  // Header row
  text_objects.push(mk_cell('Rank',rankX,start_y - 40));
  text_objects.push(mk_cell('Name',nameX,start_y - 40));
  text_objects.push(mk_cell('Score',scoreX,start_y - 40));

  // Loop through high scores and create Text objects for each entry
  highscores.forEach((entry, index) => {
    let y_pos = start_y + (index * row_height);
    last_y_pos = y_pos;

    text_objects.push(mk_cell(`${index + 1}`.padStart(3,'0'),rankX,y_pos));  // Rank
    text_objects.push(mk_cell(entry.name,nameX,y_pos));  // Player Name
    text_objects.push(mk_cell(entry.score.toString().padStart(3,'0'),scoreX,y_pos));  // Player Score
  });

  // Add a message to restart a game
  text_objects.push(mk_cell('Press [r] to restart',canvas.width/2,last_y_pos + (row_height * 1.5),bold_font));

  return text_objects;
}

function new_banner(msg, colorname) {
  return Text({
    text: msg,
    font: '54px Arial',
    color: colorname,
    x: canvas.width/2,
    y: 75,
    anchor: {x: 0.5, y: 0.5},
    textAlign: 'center'
  });
}

let game_title = new_banner('🌈 Chromatic Crawl 🦄', 'yellow');
let highscores_title = new_banner('🏆 -= Highscore =- 🏆', 'gold');

let game_over = Text({
  text: 'Game Over\n\nYour score: ' + player_score,
  font: 'italic 58px Arial',
  color: 'red',
  x: canvas.width/2,
  y: 100,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center',
  update: function () {
    this.text = 'Game Over\nYour score: ' + player_score
  }
});

// Chromatic Overdrive (Violet's blessing) flourish: rather than sitting
// static white on the win screen, the congratulations text cycles through
// every color the player just spent the run reclaiming — a small, free
// payoff for finishing the rainbow, reusing colors already defined in
// RAINBOW rather than any new asset.
let winFrame = 0;
let game_won = Text({
  text: '🎉Congratulation🎉\n\nYour score: ' + player_score,
  font: 'italic 58px Arial',
  color: 'white',
  x: canvas.width/2,
  y: 100,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center',
  update: function () {
    this.text = '🎉Congratulation🎉\nYour score: ' + player_score;
    this.color = RAINBOW[((winFrame++ / 12) | 0) % RAINBOW.length];
  }
});

let start_again = Text({
  text: 'Press [r] to restart',
  font: 'bold 16px Arial',
  color: 'white',
  x: canvas.width/2,
  y: 225,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center'
});

let start = Text({
  text: 'Start',
  onDown: function() {
    // handle on down events on the sprite
    game_state = 2;
  },
  onOver: function() {
    this.font = bold_font;
  },
  onOut: function() {
    this.font = normal_font;
  },
  ...text_options
});

let highscore = Text({
  text: 'Highscore',
  onDown: function() {
    // handle on down events on the sprite
    game_state = 5;
  },
  onOver: function() {
    this.font = bold_font;
  },
  onOut: function() {
    this.font = normal_font;
  },
  ...text_options
});

let start_menu = Grid({
  x: canvas.width/2,
  y: 250,
  anchor: {x: 0.5, y: 0.5},

  // add 15 pixels of space between each row
  rowGap: 15,

  // center the children
  justify: 'center',

  children: [start, highscore]
});
track(start,highscore);

function initGame(reason, level) {
  if (reason == 'restart') {
    chrono.reset();
    player_score = 0;
    player_name = '';
    is_name_entered = false;
    cutscene = null;
    MAX_HEALTH = 3; // undo any Red (Vitality) blessing from the previous run
    player.dashSpeedMult = 1;
    player.dashCooldownMult = 1;
    player.iFrameBonus = 0;
    player.dashReachBonus = 0;
    player.shieldCharges = 0;
    player.rainbowComplete = false;
    winFrame = 0;
    player_health = MAX_HEALTH;
  }

  current_level = level;
  dungeon = generateDungeon(level);
  currentRoomId = dungeon.startId;
  player.x = roomView.width / 2;
  player.y = roomView.height / 2;
  player.invincibleFrames = 0;
  player.dashFrames = 0;
  player.dashCooldownFrames = 0;

  chrono.start();
}

// Initialization of the game
initGame('start',current_level);

// --- Main Loop ---
let scoreTable = [];
let loop = GameLoop({  // create the main game loop
  update: function() { // update the game state
    let highscores = [];
    switch (game_state) {
      case 1:
        break;
      case 2: {
        updatePlayer();
        let room = dungeon.rooms.get(currentRoomId);
        updateBoss(room);
        checkBossContact(room);
        updateEnemies();
        break;
      }
      case 3:
        game_over.update();
        // Check if player made a high score
        highscores = get_highscores();
        break;
      case 4:
        game_won.update();
        // Check if player made a high score
        highscores = get_highscores();
        if (!is_name_entered && !readyForNameEntry && (highscores.length < MAX_HIGH_SCORES || player_score > highscores[highscores.length - 1].score)) {
          // Player has a high score — don't jump straight to name entry,
          // or the win screen (and its color-cycle text) never gets a
          // render pass. Flag it and let Enter drive the transition
          // instead, via the onKey('enter', ...) handler above.
          readyForNameEntry = true;
        }
        break;
      case 5:
        scoreTable = generate_score_table(get_highscores());
        break;
      case 6:
        break; // fully driven by onKey handlers; nothing to poll each tick
      case 7:
        updateCutscene();
        break;
    }
  },
  render: function() { // render the game state
    switch (game_state) {
      case 1:
        game_title.render();
        start_menu.render();
        break;
      case 2: {
        let ctx = kontraGetContext();
        ctx.save();
        ctx.translate(0, BANNER_H);
        renderRoom(dungeon.rooms.get(currentRoomId), dungeon, roomView);
        renderPlayer();
        renderEnemies();
        ctx.restore();
        renderBanner();
        break;
      }
      case 3:
        game_over.render();
        start_again.render();
        break;
      case 4:
        game_won.render();
        if (readyForNameEntry) {
          mk_cell('New High Score! Press [Enter] to continue', canvas.width / 2, 260, bold_font).render();
        }
        break;
      case 5:
        highscores_title.render()
        // Render the high score table
        scoreTable.forEach(row => row.render());
        break;
      case 6:
        mk_cell('New High Score!', canvas.width/2, 120, bold_font).render();
        mk_cell('Type up to 3 letters, Enter to confirm (Esc to clear)', canvas.width/2, 160).render();
        mk_cell(player_name.toUpperCase(), canvas.width/2, 210, bold_font).render();
        break;
      case 7: {
        let ctx = kontraGetContext();
        ctx.save();
        ctx.translate(0, BANNER_H);
        renderRoom(dungeon.rooms.get(currentRoomId), dungeon, roomView);
        renderPlayer();
        renderCutscene();
        ctx.restore();
        renderBanner();
        break;
      }
    }
  }
});

loop.start();    // start the game