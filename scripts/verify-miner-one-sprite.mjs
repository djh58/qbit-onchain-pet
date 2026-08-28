#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const WIDTH = 384;
const HEIGHT = 468;
const CELL_WIDTH = 48;
const CELL_HEIGHT = 52;
const FRAME_COUNTS = [8, 8, 8, 4, 5, 8, 6, 6, 6];
const GOLD = new Set(["e69700", "ffcc2a", "975400"]);
const WOOD = new Set(["7c461f", "b76c32"]);
const STEEL = new Set(["7f918b", "dae0de"]);

function decode(path, width, height) {
  const result = spawnSync("ffmpeg", [
    "-loglevel", "error", "-i", resolve(path),
    "-vf", `scale=${width}:${height}:flags=neighbor`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  if (result.stdout.length !== width * height * 4) throw new Error("decoded dimensions do not match");
  return result.stdout;
}

function colorAt(buffer, x, y, width) {
  const offset = (y * width + x) * 4;
  return buffer.subarray(offset, offset + 3).toString("hex");
}

const [, , basePath, targetPath] = process.argv;
if (!basePath || !targetPath) {
  console.error("usage: verify-miner-one-sprite.mjs <base.webp> <miner-one.webp>");
  process.exit(2);
}

const base = decode(basePath, WIDTH, HEIGHT);
const target = decode(targetPath, WIDTH, HEIGHT);
for (let row = 0; row < FRAME_COUNTS.length; row += 1) {
  for (let column = 0; column < 8; column += 1) {
    let changed = 0;
    let gold = 0;
    let wood = 0;
    let steel = 0;
    for (let y = row * CELL_HEIGHT; y < (row + 1) * CELL_HEIGHT; y += 1) {
      for (let x = column * CELL_WIDTH; x < (column + 1) * CELL_WIDTH; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        if (!target.subarray(offset, offset + 4).equals(base.subarray(offset, offset + 4))) changed += 1;
        const color = colorAt(target, x, y, WIDTH);
        if (GOLD.has(color)) gold += 1;
        if (WOOD.has(color)) wood += 1;
        if (STEEL.has(color)) steel += 1;
      }
    }
    const occupied = column < FRAME_COUNTS[row];
    if (!occupied && changed !== 0) throw new Error(`unused cell changed at row ${row}, column ${column}`);
    if (occupied && (gold < 30 || wood < 6 || steel < 4)) {
      throw new Error(`accessory missing at row ${row}, column ${column}: gold=${gold} wood=${wood} steel=${steel}`);
    }
  }
}

const full = decode(targetPath, 1536, 1872);
for (let y = 0; y < 1872; y += 4) {
  for (let x = 0; x < 1536; x += 4) {
    const first = full.subarray((y * 1536 + x) * 4, (y * 1536 + x) * 4 + 4);
    for (let dy = 0; dy < 4; dy += 1) {
      for (let dx = 0; dx < 4; dx += 1) {
        const offset = ((y + dy) * 1536 + x + dx) * 4;
        if (!full.subarray(offset, offset + 4).equals(first)) {
          throw new Error(`nonuniform 4x pixel block at ${x},${y}`);
        }
      }
    }
  }
}

console.log("Miner One sprite verification OK: every occupied cell has a helmet and pickaxe; unused cells are unchanged; 4× pixel grid is exact.");
