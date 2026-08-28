#!/usr/bin/env node

// Rebuild Miner One from the canonical Qbit sheet at its native logical pixel
// grid. The #1 hardhat and animated pickaxe were designed from the approved
// image-generation concept, then redrawn deterministically so every 4×4 block
// survives lossless on-chain encoding exactly.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const LOGICAL_WIDTH = 384;
const LOGICAL_HEIGHT = 468;
const CELL_WIDTH = 48;
const CELL_HEIGHT = 52;
const FRAME_COUNTS = [8, 8, 8, 4, 5, 8, 6, 6, 6];

const GREEN = [27, 181, 83];
const OUTLINE = [14, 40, 24];
const LIGHT = [240, 255, 245];
const GOLD = [230, 151, 0];
const GOLD_LIGHT = [255, 204, 42];
const GOLD_SHADOW = [151, 84, 0];
const WOOD = [124, 70, 31];
const WOOD_LIGHT = [183, 108, 50];
const STEEL = [127, 145, 139];
const STEEL_LIGHT = [218, 224, 222];

function usage() {
  console.error("usage: build-miner-one-sprite.mjs <base.webp> <output.webp>");
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: null, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function pixelOffset(x, y) {
  return (y * LOGICAL_WIDTH + x) * 4;
}

function pixelMatches(buffer, x, y, color) {
  const offset = pixelOffset(x, y);
  return buffer[offset] === color[0] && buffer[offset + 1] === color[1]
    && buffer[offset + 2] === color[2] && buffer[offset + 3] > 0;
}

function setPixel(buffer, x, y, color, alpha = 255) {
  if (x < 0 || y < 0 || x >= LOGICAL_WIDTH || y >= LOGICAL_HEIGHT) return;
  const offset = pixelOffset(x, y);
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
  buffer[offset + 3] = alpha;
}

function drawLine(buffer, x0, y0, x1, y1, color, radius = 0, bounds = null) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const targetX = Math.round(x1);
  const targetY = Math.round(y1);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        const drawX = x + ox;
        const drawY = y + oy;
        if (Math.abs(ox) + Math.abs(oy) <= radius
          && (!bounds || (drawX >= bounds.left && drawX <= bounds.right
            && drawY >= bounds.top && drawY <= bounds.bottom))) {
          setPixel(buffer, drawX, drawY, color);
        }
      }
    }
    if (x === targetX && y === targetY) break;
    const doubled = 2 * error;
    if (doubled >= dy) { error += dy; x += sx; }
    if (doubled <= dx) { error += dx; y += sy; }
  }
}

function largestGreenComponent(buffer, row, column) {
  const originX = column * CELL_WIDTH;
  const originY = row * CELL_HEIGHT;
  const seen = new Set();
  let largest = [];
  for (let y = originY; y < originY + CELL_HEIGHT; y += 1) {
    for (let x = originX; x < originX + CELL_WIDTH; x += 1) {
      const key = y * LOGICAL_WIDTH + x;
      if (seen.has(key) || !pixelMatches(buffer, x, y, GREEN)) continue;
      const component = [];
      const queue = [[x, y]];
      seen.add(key);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const [nextX, nextY] = queue[cursor];
        component.push([nextX, nextY]);
        for (const [candidateX, candidateY] of [
          [nextX - 1, nextY], [nextX + 1, nextY],
          [nextX, nextY - 1], [nextX, nextY + 1],
        ]) {
          if (candidateX < originX || candidateX >= originX + CELL_WIDTH
            || candidateY < originY || candidateY >= originY + CELL_HEIGHT) continue;
          const candidateKey = candidateY * LOGICAL_WIDTH + candidateX;
          if (seen.has(candidateKey) || !pixelMatches(buffer, candidateX, candidateY, GREEN)) continue;
          seen.add(candidateKey);
          queue.push([candidateX, candidateY]);
        }
      }
      if (component.length > largest.length) largest = component;
    }
  }
  if (largest.length < 20) throw new Error(`could not locate Qbit body in row ${row}, column ${column}`);
  return {
    minX: Math.min(...largest.map(([x]) => x)),
    maxX: Math.max(...largest.map(([x]) => x)),
    minY: Math.min(...largest.map(([, y]) => y)),
    maxY: Math.max(...largest.map(([, y]) => y)),
  };
}

function drawHardhat(buffer, row, column, body) {
  const bounds = {
    left: column * CELL_WIDTH,
    right: (column + 1) * CELL_WIDTH - 1,
    top: row * CELL_HEIGHT,
    bottom: (row + 1) * CELL_HEIGHT - 1,
  };
  const draw = (x, y, color) => {
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
      throw new Error(`hardhat escaped row ${row}, column ${column} at ${x},${y}`);
    }
    setPixel(buffer, x, y, color);
  };
  const centerX = Math.max(
    bounds.left + 11,
    Math.min(bounds.right - 11, Math.round((body.minX + body.maxX) / 2)),
  );
  // Jumping poses can reach the top of their cell. In those frames the helmet
  // sits over the crown rather than writing into the previous animation row.
  const brimY = Math.max(bounds.top + 9, body.minY + 1);
  const top = brimY - 9;
  const halfWidths = [3, 5, 7, 8, 9, 9, 9];
  halfWidths.forEach((halfWidth, dy) => {
    for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 1) {
      const edge = x === centerX - halfWidth || x === centerX + halfWidth || dy === 0;
      const color = edge ? OUTLINE : x < centerX - 3 ? GOLD_LIGHT : x > centerX + 5 ? GOLD_SHADOW : GOLD;
      draw(x, top + dy, color);
    }
  });
  for (let x = centerX - 11; x <= centerX + 11; x += 1) draw(x, brimY - 2, OUTLINE);
  for (let x = centerX - 10; x <= centerX + 10; x += 1) draw(x, brimY - 1, GOLD_LIGHT);
  for (let x = centerX - 11; x <= centerX + 11; x += 1) draw(x, brimY, OUTLINE);

  const badgeLeft = centerX - 5;
  const badgeTop = top + 1;
  for (let y = badgeTop; y < badgeTop + 7; y += 1) {
    for (let x = badgeLeft; x < badgeLeft + 11; x += 1) draw(x, y, OUTLINE);
  }
  const glyph = ["010100010", "111110110", "010100010", "111110010", "010100111"];
  glyph.forEach((line, dy) => [...line].forEach((value, dx) => {
    if (value === "1") draw(badgeLeft + 1 + dx, badgeTop + 1 + dy, LIGHT);
  }));
}

function pickaxeGeometry(row, column, body) {
  const originX = column * CELL_WIDTH;
  const originY = row * CELL_HEIGHT;
  const phase = (column % 4) - 1.5;
  if (row === 5) {
    return {
      bottom: [body.maxX - 1, Math.min(originY + 45, body.maxY + 2)],
      top: [originX + 42, Math.min(originY + 42, body.maxY + 5)],
    };
  }
  if (row === 3) {
    return {
      bottom: [body.maxX + 3, body.maxY - 1],
      top: [body.maxX + 4 + Math.round(phase / 2), body.minY - 4],
    };
  }
  const side = row === 2 ? -1 : 1;
  const bodyEdge = side < 0 ? body.minX : body.maxX;
  const centerY = (body.minY + body.maxY) / 2;
  const unclampedBottomX = bodyEdge + side * 2;
  const unclampedTopX = bodyEdge + side * (6 + (column % 2));
  return {
    bottom: [Math.max(originX + 6, Math.min(originX + 41, unclampedBottomX)), Math.round(centerY + 8 - phase)],
    top: [Math.max(originX + 7, Math.min(originX + 40, unclampedTopX)), Math.round(centerY - 7 + phase)],
  };
}

function drawPickaxe(buffer, row, column, body) {
  const { bottom, top } = pickaxeGeometry(row, column, body);
  const bounds = {
    left: column * CELL_WIDTH,
    right: (column + 1) * CELL_WIDTH - 1,
    top: row * CELL_HEIGHT,
    bottom: (row + 1) * CELL_HEIGHT - 1,
  };
  drawLine(buffer, bottom[0], bottom[1], top[0], top[1], OUTLINE, 1, bounds);
  drawLine(buffer, bottom[0], bottom[1], top[0], top[1], WOOD, 0, bounds);
  if (bottom[0] >= bounds.left && bottom[0] <= bounds.right
    && bottom[1] >= bounds.top && bottom[1] <= bounds.bottom) setPixel(buffer, bottom[0], bottom[1], WOOD_LIGHT);
  const dx = top[0] - bottom[0];
  const dy = top[1] - bottom[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  const perpendicularX = -dy / length;
  const perpendicularY = dx / length;
  const halfLength = row === 5 ? 4 : 5;
  const start = [top[0] - perpendicularX * halfLength, top[1] - perpendicularY * halfLength];
  const end = [top[0] + perpendicularX * halfLength, top[1] + perpendicularY * halfLength];
  drawLine(buffer, start[0], start[1], end[0], end[1], OUTLINE, 1, bounds);
  drawLine(buffer, start[0], start[1], end[0], end[1], STEEL, 0, bounds);
  for (const [tipX, tipY] of [start, end]) {
    const roundedX = Math.round(tipX);
    const roundedY = Math.round(tipY);
    if (roundedX >= bounds.left && roundedX <= bounds.right
      && roundedY >= bounds.top && roundedY <= bounds.bottom) setPixel(buffer, roundedX, roundedY, STEEL_LIGHT);
  }
}

const [, , baseArgument, outputArgument] = process.argv;
if (!baseArgument || !outputArgument) usage();
const base = resolve(baseArgument);
const output = resolve(outputArgument);
const logical = run("ffmpeg", [
  "-loglevel", "error", "-i", base,
  "-vf", `scale=${LOGICAL_WIDTH}:${LOGICAL_HEIGHT}:flags=neighbor`,
  "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-",
]);
if (logical.length !== LOGICAL_WIDTH * LOGICAL_HEIGHT * 4) {
  throw new Error(`unexpected base byte length ${logical.length}`);
}
for (let row = 0; row < FRAME_COUNTS.length; row += 1) {
  for (let column = 0; column < FRAME_COUNTS[row]; column += 1) {
    const body = largestGreenComponent(logical, row, column);
    drawPickaxe(logical, row, column, body);
    drawHardhat(logical, row, column, body);
  }
}

mkdirSync(dirname(output), { recursive: true });
const enlargedPng = run("ffmpeg", [
  "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
  "-s", `${LOGICAL_WIDTH}x${LOGICAL_HEIGHT}`, "-i", "-",
  "-vf", "scale=1536:1872:flags=neighbor", "-frames:v", "1",
  "-c:v", "png", "-f", "image2pipe", "-",
], { input: logical });
run("cwebp", ["-quiet", "-lossless", "-z", "9", "-metadata", "none", "-o", output, "--", "-"], { input: enlargedPng });
console.log(output);
