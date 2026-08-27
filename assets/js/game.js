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
const TEXTURES = ['plain', 'dots', 'brick', 'grid', 'diagonal', 'stone'];

function pickTexture() {
  return TEXTURES[(Math.random() * TEXTURES.length) | 0];
}

// ---- Stone floor (irregular flagstones, grouped into square modules) ------
// First pass used coursed rows of similar-height slabs — that's a masonry
// *wall* technique (stretcher bond), which is why it read wrong for a
// floor. This instead mimics tabletop-dungeon-tile flooring: the floor is
// divided into square macro cells (like individual physical tile pieces),
// and each cell is recursively split (BSP-style) into stone chunks of very
// different sizes — "crazy paving" rather than aligned rows.
//
// Like the coursed version, this needs real per-room randomness (which cuts
// happen where), so it's built ONCE per room and cached as room.stoneTiles.
// drawStoneTexture() only ever reads that cached list — never calls
// Math.random() itself — so the floor stays static frame to frame instead
// of re-cracking every tick.
const STONE_CELL = 90;          // target macro cell size (~one "tile square")
const STONE_MIN = 10;           // smallest stone chunk allowed
const STONE_MAX_DEPTH = 4;      // subdivision depth cap, bounds stone count
const STONE_STOP_CHANCE = 0.28; // chance to stop subdividing early, for size variety
const STONE_MORTAR = 2;         // gap between stones, reads as grout

function subdivideStone(x, y, w, h, depth, out) {
  let tooSmall = w < STONE_MIN * 2 && h < STONE_MIN * 2;
  if (depth >= STONE_MAX_DEPTH || tooSmall || Math.random() < STONE_STOP_CHANCE) {
    out.push({ x, y, w, h, shade: (Math.random() * 16) - 8 });
    return;
  }

  // Usually split along the longer axis (keeps chunks from going sliver-thin),
  // but flip sometimes so it doesn't read as a predictable grid.
  let splitVertical = w >= h;
  if (Math.random() < 0.25) splitVertical = !splitVertical;

  if (splitVertical) {
    let lo = STONE_MIN, hi = w - STONE_MIN;
    if (hi <= lo) { out.push({ x, y, w, h, shade: (Math.random() * 16) - 8 }); return; }
    let cut = lo + Math.random() * (hi - lo);
    subdivideStone(x, y, cut, h, depth + 1, out);
    subdivideStone(x + cut, y, w - cut, h, depth + 1, out);
  } else {
    let lo = STONE_MIN, hi = h - STONE_MIN;
    if (hi <= lo) { out.push({ x, y, w, h, shade: (Math.random() * 16) - 8 }); return; }
    let cut = lo + Math.random() * (hi - lo);
    subdivideStone(x, y, w, cut, depth + 1, out);
    subdivideStone(x, y + cut, w, h - cut, depth + 1, out);
  }
}

function buildStoneTiles(fw, fh) {
  let tiles = [];
  let cols = Math.max(1, Math.round(fw / STONE_CELL));
  let rows = Math.max(1, Math.round(fh / STONE_CELL));
  let cellW = fw / cols, cellH = fh / rows;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      subdivideStone(cx * cellW, cy * cellH, cellW, cellH, 0, tiles);
    }
  }
  return tiles;
}

// Draws the cached chunk list, offset into the floor rect, with a light
// top/left edge and dark bottom/right edge on each chunk to fake a bevel —
// cheap 3D read without any image assets.
function drawStoneTexture(ctx, room, fx, fy) {
  (room.stoneTiles || []).forEach(t => {
    let bx = fx + t.x, by = fy + t.y;
    let bw = t.w - STONE_MORTAR, bh = t.h - STONE_MORTAR;
    if (bw <= 0 || bh <= 0) return;

    ctx.fillStyle = shadeColor(room.color, t.shade - 6);
    ctx.fillRect(bx, by, bw, bh);

    ctx.strokeStyle = shadeColor(room.color, t.shade + 20);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by + bh);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + bw, by);
    ctx.stroke();

    ctx.strokeStyle = shadeColor(room.color, t.shade - 28);
    ctx.beginPath();
    ctx.moveTo(bx + bw, by);
    ctx.lineTo(bx + bw, by + bh);
    ctx.lineTo(bx, by + bh);
    ctx.stroke();
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
  if (!room.texture || room.texture === 'plain') return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, fw, fh);
  ctx.clip();

  let light = shadeColor(room.color, 18);
  let dark = shadeColor(room.color, -18);

  switch (room.texture) {
    case 'dots':
      ctx.fillStyle = dark;
      for (let y = fy + 12; y < fy + fh; y += 24) {
        for (let x = fx + 12; x < fx + fw; x += 24) {
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;

    case 'brick': {
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

    case 'grid':
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

    case 'diagonal':
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let x = fx - fh; x < fx + fw; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, fy);
        ctx.lineTo(x + fh, fy + fh);
        ctx.stroke();
      }
      break;

    case 'stone':
      drawStoneTexture(ctx, room, fx, fy);
      break;
  }

  ctx.restore();
}

function finalizeDungeon(occupied, endRooms, levelColor) {
  let rooms = Array.from(occupied.values());
  rooms.forEach(r => {
    r.type = 'normal';
    r.cleared = true;
    r.hasGuardian = false;
    r.enemies = [];
    r.texture = pickTexture();
    if (r.texture === 'stone') {
      r.stoneTiles = buildStoneTiles(canvas.width - 2 * WALL, canvas.height - 2 * WALL);
    }
  });

  let start = occupied.get(START_ID);
  start.type = 'start';
  start.cleared = true;

  let bossId = endRooms[endRooms.length - 1];
  let boss = occupied.get(bossId);
  boss.type = 'boss';
  boss.hasGuardian = true;
  boss.cleared = false;
  boss.color = levelColor;

  // Palette-swapped enemy archetypes: every normal room has a coin-flip
  // chance of one enemy, tinted to this level's rainbow color. Doesn't touch
  // room.cleared — these are roaming hazards in already-open rooms, not a
  // new lock/clear gate.
  rooms.forEach(r => {
    if (r.type === 'normal' && Math.random() < 0.5) {
      r.enemies.push(spawnEnemy(levelColor));
    }
  });

  return { rooms: occupied, startId: START_ID, bossId };
}

// ---- Public entry point, with retry-on-failure ------------------------------
function generateDungeon(level, targetRooms = 13, maxAttempts = 60) {
  let levelColor = colorForLevel(level);
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
  console.warn('generateDungeon: hit maxAttempts, using last floorplan as-is');
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

function renderRoom(room, dungeon, canvas) {
  let ctx = kontra.getContext();
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
    if (guardianSprite) {
      guardianSprite.x = w / 2;
      guardianSprite.y = h / 2;
      guardianSprite.render();
    } else {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 24, 0, Math.PI * 2);
      ctx.fill();
    }
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
  let ctx = kontra.getContext();
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
  let ctx = kontra.getContext();
  if (!playerSprite) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_SIZE, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  playerSprite.x = player.x;
  playerSprite.y = player.y;
  playerSprite.scaleX = playerFacingLeft ? -1 : 1;
  playerSprite.render();
}

// ============================================================================
// ROOM TRANSITIONS
// Doors only open once room.cleared is true. Walking into an open door swaps
// currentRoomId and repositions the player at the opposite door — this is
// the entire "camera" system, since the canvas never actually pans.
// ============================================================================

function tryMoveThroughDoor(dungeon, currentRoomId, dir) {
  let room = dungeon.rooms.get(currentRoomId);
  if (!room.cleared) return currentRoomId; // locked
  let nextId = room.doors[dir];
  if (nextId === undefined) return currentRoomId;
  return nextId;
}

function opposite(dir) {
  return { n: 's', s: 'n', e: 'w', w: 'e' }[dir];
}

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
// update tick while game_state == 2 (play).
function updatePlayer() {
  let dx = keyPressed('arrowright') - keyPressed('arrowleft');
  let dy = keyPressed('arrowdown') - keyPressed('arrowup');
  let moving = dx || dy;

  updatePlayerAnimation(moving, dx);
  if (!moving) return;

  if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
  let room = dungeon.rooms.get(currentRoomId);
  let nx = player.x + dx * PLAYER_SPEED;
  let ny = player.y + dy * PLAYER_SPEED;
  if (dx && !isBlockedByWall(nx, player.y, room, canvas)) player.x = nx;
  if (dy && !isBlockedByWall(player.x, ny, room, canvas)) player.y = ny;
  checkDoorCrossing(room, canvas);
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

function updateGuardianAnimation() {
  if (!guardianSprite) return;
  let room = dungeon.rooms.get(currentRoomId);
  if (room.hasGuardian && !room.cleared) guardianSprite.update();
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

let collected_colors = [];

function checkGuardianContact() {
  if (game_state !== 2) return;
  let room = dungeon.rooms.get(currentRoomId);
  if (!room.hasGuardian || room.cleared) return;

  let center = { x: canvas.width / 2, y: canvas.height / 2 };
  if (dist(player, center) < 40) { // guardian marker radius (24) + player reach
    defeatGuardian(room);
  }
}

function defeatGuardian(room) {
  room.cleared = true;
  room.hasGuardian = false;
  playSound('squash');

  if (room.type === 'boss') {
    collectColor(room.color);
  } else {
    player_score += 50; // minor room, tune later
  }
}

function collectColor(color) {
  collected_colors.push(color);
  player_score += 100 + computeTimeBonus(chrono.getElapsed());
  playSound('pickup');
  advanceOrWin();
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
  let x = canvas.width / 2 + (Math.random() * 160 - 80);
  let y = canvas.height / 2 + (Math.random() * 100 - 50);
  let type = ARCHETYPES[(Math.random() * ARCHETYPES.length) | 0];
  return {
    type, color, x, y, homeX: x, homeY: y,
    dir: Math.random() < 0.5 ? 1 : -1,
    speed: ENEMY_SPEED[type],
    sprite: null, // built lazily once creatureBaseImg has finished loading
    alive: true,
  };
}

function updateEnemy(e, room) {
  if (!e.alive) return;
  if (e.type === 'chaser') {
    let dx = player.x - e.x, dy = player.y - e.y;
    let len = Math.hypot(dx, dy) || 1;
    let nx = e.x + (dx / len) * e.speed;
    let ny = e.y + (dy / len) * e.speed;
    if (!isBlockedByWall(nx, e.y, room, canvas)) e.x = nx;
    if (!isBlockedByWall(e.x, ny, room, canvas)) e.y = ny;
  } else if (e.type === 'patroller') {
    let nx = e.x + e.speed * e.dir;
    if (isBlockedByWall(nx, e.y, room, canvas) || Math.abs(nx - e.homeX) > 70) {
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
  let ctx = kontra.getContext();
  ctx.fillStyle = ENEMY_TINTS[e.color] || '#888';
  ctx.beginPath();
  ctx.arc(e.x, e.y, ENEMY_SIZE / 2, 0, Math.PI * 2);
  ctx.fill();
}

// Contact resolution is a placeholder — wire this into whatever
// ability/damage system you land on. For now, touching an enemy just
// removes it, matching the "contact/ability-based, no aimed shooting" design.
function checkEnemyContact(room) {
  if (!room.enemies) return;
  room.enemies.forEach(e => {
    if (e.alive && dist(player, e) < ENEMY_SIZE / 2 + PLAYER_SIZE) {
      e.alive = false;
      playSound('squash');
    }
  });
}

function updateEnemies() {
  let room = dungeon.rooms.get(currentRoomId);
  if (!room.enemies) return;
  room.enemies.forEach(e => updateEnemy(e, room));
  checkEnemyContact(room);
}

function renderEnemies() {
  let room = dungeon.rooms.get(currentRoomId);
  if (!room.enemies) return;
  room.enemies.forEach(renderEnemy);
}


let { init, TileEngine, Sprite, GameLoop, initKeys, initPointer, keyPressed, onKey, Text, Grid, track, clamp, collides, SpriteSheet, loadImage } = kontra;

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
function playSound(type){
  switch(type){
    case "jump": 
      zzfx(...[.7,,177,.01,.02,.05,,.1,,35,,,,,,,,.81,.02,,146]);
      break;
    case "rebound":
      zzfx(...[2.1,,358,.02,.01,.17,4,3.6,,,,,,.6,15,.4,.17,.75,.06]);
      break;
    case "dash":
      zzfx(...[,,400,.05,.15,.2,,2]);
      break;
    case "squash":
      zzfx(...[,,60,.2,.3,.4,2]);
      break;
    case "pickup":
      zzfx(...[1.5,,539,,,.06,,.8,,,,,,.1,,,,.65]);
      break;
    case "catStep1":
      // a light, soft step
      zzfx(...[,,120,.01,.02,.02,1,1.5,,.5]); 
      break;
    case "catStep2":
      // a more subdued variant, slightly higher in pitch
      zzfx(...[,,160,.01,.015,.02,1,1.2,,.6]); 
      break;

  }
}

const { canvas } = init();
initPointer();
initKeys();

// ------------ LOAD SPRITESHEETS ------------

const IMG_PATH = 'assets/img/';   // ← adjust if your art lives elsewhere
const PLAYER_SPRITE_SIZE = 28;
const GUARDIAN_SPRITE_SIZE = 48;

let playerSprite = null;
let guardianSprite = null;
let playerFacingLeft = false;
let creatureBaseImg = null; // raw, untinted creature-sheet — every enemy/guardian recolors from this one image

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

loadImage(IMG_PATH + 'creature-sheet.png').then(img => {
  creatureBaseImg = img;
  guardianSprite = makeCreatureSprite('violet', GUARDIAN_SPRITE_SIZE);
});

// ------------ CONSTANT ------------
const bold_font = 'bold 20px Arial, sans-serif';
const normal_font = '20px Arial, sans-serif';
const text_options = {
  color: 'white',
  font: normal_font
};

// ------------ Global ------------
//let tileEngine = [];
let dungeon;
let currentRoomId;
let player = { x: 0, y: 0 };
let MAX_HIGH_SCORES = 5;
let game_level = 1;
let game_state = 1; // 'menu' = 1, 'play' = 2, 'gameover' = 3, 'gamewon' = 4, 'highscores' = 5
let player_score = 0;
let player_name = '';
let is_name_entered = false;
let current_level = 1;

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

function is_last_level(level){ return level == NUMBER_OF_LEVELS;}

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
      console.log("r key pressed ! ");
      game_state = 1;
      initGame('restart', current_level);
    }
  };
}
'abcdefghijklmnopqrstuvwxyz'.split('').forEach(letter => onKey(letter, handleLetterKey(letter)));

onKey('esc', () => { if (game_state === 6) player_name = ''; }); // clear a mistyped name
onKey('enter', () => {
  if (game_state === 6 && player_name.length > 0) {
    save_highscore(player_score, player_name.toUpperCase());
    game_state = 5; // show the updated highscore table
  }
});

// NOTE: tryMoveThroughDoor() and moveThroughDoor() (further up the file, in
// the ROOM TRANSITIONS section) are no longer called anywhere — replaced by
// checkDoorCrossing()/updatePlayer(). Left in place rather than deleted,
// since you may still want tryMoveThroughDoor's "locked door" semantics
// elsewhere (e.g. a minimap click-to-travel feature). Safe to remove if not.

function get_highscores() {
  // Retrieve scores from localStorage or return an empty array if not present
  return JSON.parse(localStorage.getItem('chromatic_crawl_highscores')) || [];
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
  localStorage.setItem('chromatic_crawl_highscores', JSON.stringify(highscores));
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

let game_won = Text({
  text: '🎉Congratulation🎉\n\nYour score: ' + player_score,
  font: 'italic 58px Arial',
  color: 'white',
  x: canvas.width/2,
  y: 100,
  anchor: {x: 0.5, y: 0.5},
  textAlign: 'center',
  update: function () {
    this.text = '🎉Congratulation🎉\nYour score: ' + player_score
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
    console.log("Clicked on Start");
    game_state = 2;
    game_points_multiplier = 0;
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
    console.log("Clicked on High Score");
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

// helper to convert col/row → centered pixel coordinates
function tileToXY(col, row, tileEngine) {
  let tw = tileEngine.tilewidth;
  let th = tileEngine.tileheight;
  return {
    x: col * tw + tw/2,
    y: row * th + th/2
  };
}

function initGame(reason,level) {
  if (reason == 'restart'){
    chrono.reset();
    // -- reinit variable used for game score
    player_score = 0;
    player_name = '';
    is_name_entered = false;
    collected_colors = [];
  } else if (reason == 'nextlevel'){
    game_level = level;
    dungeon = generateDungeon(level);
    currentRoomId = dungeon.startId;
    player.x = canvas.width / 2;
    player.y = canvas.height / 2;
  };

  chrono.start();
  game_level = level;
  dungeon = generateDungeon(level);
  currentRoomId = dungeon.startId;
  player.x = canvas.width / 2;
  player.y = canvas.height / 2;
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
      case 2:
        updatePlayer();
        checkGuardianContact();
        updateGuardianAnimation();
        updateEnemies();
        break;
      case 3:
        game_over.update();
        // Check if player made a high score
        highscores = get_highscores();
        break;
      case 4:
        game_won.update();
        // Check if player made a high score
        highscores = get_highscores();
        if (!is_name_entered && (highscores.length < MAX_HIGH_SCORES || player_score > highscores[highscores.length - 1].score)) {
          // Player has a high score — collect their name via in-canvas
          // entry instead of prompt(), which is blocked in the sandboxed
          // iframe js13k entries are played in.
          player_name = '';
          is_name_entered = true; // guards against re-triggering every frame
          game_state = 6;
        }
        break;
      case 5:
        scoreTable = generate_score_table(get_highscores());
        break;
      case 6:
        break; // fully driven by onKey handlers; nothing to poll each tick
    }
  },
  render: function() { // render the game state
    switch (game_state) {
      case 1:
        game_title.render();
        start_menu.render();
        break;
      case 2:
        //tileEngine.render();
        renderRoom(dungeon.rooms.get(currentRoomId), dungeon, canvas);
        renderPlayer();
        renderEnemies();
        renderMinimap(dungeon, currentRoomId);
        break;
      case 3:
        game_over.render();
        start_again.render();
        break;
      case 4:
        game_won.render();
        start_again.render();
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
    }
  }
});

loop.start();    // start the game