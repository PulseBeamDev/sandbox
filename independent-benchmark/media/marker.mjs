const MAGIC = Buffer.from("G2GF");
const HEADER_BYTES = 16;
const MARKER_BYTES = HEADER_BYTES + 2;
const MARKER_COLUMNS = 16;
const CELL_SIZE = 16;
const MARKER_X = 16;
const MARKER_Y = 16;
const MARKER_ROWS = Math.ceil(MARKER_BYTES * 8 / MARKER_COLUMNS);
const MARKER_GUARD = 16;
const BLACK = 16;
const WHITE = 235;

const epochAnchorUs = BigInt(Date.now()) * 1000n;
const monotonicAnchorNs = process.hrtime.bigint();

export function epochMicros() {
  return epochAnchorUs + (process.hrtime.bigint() - monotonicAnchorNs) / 1000n;
}

export function createBaseFrame(width, height, { sourceProfile = "checkerboard" } = {}) {
  validateDimensions(width, height);
  const ySize = width * height;
  const frame = Buffer.alloc(ySize + ySize / 2, 128);

  if (sourceProfile === "checkerboard") {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const grid = ((x >> 6) ^ (y >> 6)) & 1;
        frame[y * width + x] = grid ? 82 : 112;
      }
    }
  } else if (sourceProfile === "translated-texture-v1") {
    paintTranslatedTexture(frame, width, height, 0);
  } else {
    throw new Error(`unsupported source profile: ${sourceProfile}`);
  }
  return frame;
}

export function stampFrame(baseFrame, width, height, captureUs, frameId, {
  sourceProfile = "checkerboard",
} = {}) {
  validateDimensions(width, height);
  if (baseFrame.length !== width * height * 3 / 2) {
    throw new Error("baseFrame has the wrong YUV420p size");
  }

  const frame = Buffer.from(baseFrame);
  const ySize = width * height;
  if (sourceProfile === "translated-texture-v1") {
    paintTranslatedTexture(frame, width, height, frameId);
  }
  else if (sourceProfile !== "checkerboard") throw new Error(`unsupported source profile: ${sourceProfile}`);
  const barX = (frameId * 13) % Math.max(1, width - 48);
  for (let y = 64; y < Math.min(height, 160); y += 1) {
    frame.fill(180, y * width + barX, y * width + Math.min(width, barX + 48));
  }

  const marker = Buffer.alloc(MARKER_BYTES);
  MAGIC.copy(marker, 0);
  marker.writeBigUInt64BE(BigInt(captureUs), 4);
  marker.writeUInt32BE(frameId >>> 0, 12);
  marker.writeUInt16BE(crc16(marker.subarray(0, HEADER_BYTES)), HEADER_BYTES);

  // Align each bit to its own 16x16 H.264 macroblock and isolate the grid from
  // the moving texture. The previous 8x32 strip packed two independent bits
  // into a macroblock, which could corrupt the pixel clock under strict CBR
  // even when the transport was lossless.
  const guardX0 = MARKER_X - MARKER_GUARD;
  const guardX1 = MARKER_X + MARKER_COLUMNS * CELL_SIZE + MARKER_GUARD;
  const guardY0 = MARKER_Y - MARKER_GUARD;
  const guardY1 = MARKER_Y + MARKER_ROWS * CELL_SIZE + MARKER_GUARD;
  for (let y = guardY0; y < guardY1; y += 1) {
    frame.fill(128, y * width + guardX0, y * width + guardX1);
  }
  for (let bit = 0; bit < MARKER_BYTES * 8; bit += 1) {
    const value = marker[bit >> 3] & (1 << (7 - (bit & 7)));
    const luma = value ? WHITE : BLACK;
    const column = bit % MARKER_COLUMNS;
    const row = Math.floor(bit / MARKER_COLUMNS);
    const x0 = MARKER_X + column * CELL_SIZE;
    const y0 = MARKER_Y + row * CELL_SIZE;
    for (let y = y0; y < y0 + CELL_SIZE; y += 1) {
      frame.fill(luma, y * width + x0, y * width + x0 + CELL_SIZE);
    }
  }

  // The marker itself is luma-only. Preserve the textured profile's chroma so
  // the fair benchmark exercises a real 4 Mbit/s encoder path.
  if (sourceProfile === "checkerboard") frame.fill(128, ySize);
  return frame;
}

export function readMarker(frame, width, height) {
  validateDimensions(width, height);
  if (frame.length < width * height * 3 / 2) return null;

  // Search only the nearby reconstruction-alignment window and require both
  // the fixed magic and CRC before accepting a timestamp.
  for (const [xOffset, yOffset] of markerOffsets()) {
    const { marker } = sampleMarker(frame, width, xOffset, yOffset);
    if (!marker.subarray(0, 4).equals(MAGIC)) continue;
    const expectedCrc = marker.readUInt16BE(HEADER_BYTES);
    if (crc16(marker.subarray(0, HEADER_BYTES)) !== expectedCrc) continue;
    return {
      captureUs: marker.readBigUInt64BE(4),
      frameId: marker.readUInt32BE(12),
    };
  }
  return null;
}

export function diagnoseMarker(frame, width, height) {
  validateDimensions(width, height);
  if (frame.length < width * height * 3 / 2) return null;
  const { marker, luma } = sampleMarker(frame, width);
  return {
    reconstructedHex: marker.toString("hex"),
    expectedMagicHex: MAGIC.toString("hex"),
    lumaMin: Math.min(...luma),
    lumaMax: Math.max(...luma),
    magicLuma: luma.slice(0, MAGIC.length * 8),
  };
}

function sampleMarker(frame, width, xOffset = 0, yOffset = 0) {
  const marker = Buffer.alloc(MARKER_BYTES);
  const luma = [];
  for (let bit = 0; bit < MARKER_BYTES * 8; bit += 1) {
    const column = bit % MARKER_COLUMNS;
    const row = Math.floor(bit / MARKER_COLUMNS);
    const cellX = MARKER_X + column * CELL_SIZE + xOffset;
    const cellY = MARKER_Y + row * CELL_SIZE + yOffset;
    let total = 0;
    let count = 0;
    // Average the protected center of each cell. A single reconstructed pixel
    // can cross the 128 threshold under a strict-CBR, high-motion encode even
    // though the cell remains unambiguous to a decoder.
    for (let y = cellY + 4; y < cellY + CELL_SIZE - 4; y += 2) {
      for (let x = cellX + 4; x < cellX + CELL_SIZE - 4; x += 2) {
        if (x < 0 || x >= width) continue;
        total += frame[y * width + x];
        count += 1;
      }
    }
    const value = count ? Math.round(total / count) : 0;
    luma.push(value);
    if (value >= 128) {
      marker[bit >> 3] |= 1 << (7 - (bit & 7));
    }
  }
  return { marker, luma };
}

function markerOffsets() {
  const offsets = [[0, 0]];
  for (let distance = 1; distance <= 4; distance += 1) {
    for (let y = -distance; y <= distance; y += 1) {
      offsets.push([-distance, y], [distance, y]);
    }
    for (let x = -distance + 1; x < distance; x += 1) {
      offsets.push([x, -distance], [x, distance]);
    }
  }
  return offsets;
}

// A fixed, detailed mosaic translated across the frame. This preserves the
// temporal coherence of camera video and gives the encoder real motion vectors
// to find. Regenerating random noise per frame would overwhelm a 4 Mbit/s
// 720p encoder before any transport is involved.
function paintTranslatedTexture(frame, width, height, frameId) {
  const ySize = width * height;
  const textureCell = 32;
  const renderBlock = 8;
  const cellsX = Math.ceil(width / textureCell);
  const cellsY = Math.ceil(height / textureCell);
  const shiftPixels = frameId * renderBlock;
  for (let y = 0; y < height; y += renderBlock) {
    for (let x = 0; x < width; x += renderBlock) {
      const worldX = Math.floor((x + shiftPixels) / textureCell) % cellsX;
      const worldY = Math.floor((y + shiftPixels) / textureCell) % cellsY;
      const luma = 40 + (mix32(worldX + worldY * cellsX + 0x9e3779b9) % 176);
      const x1 = Math.min(width, x + renderBlock);
      for (let row = y; row < Math.min(height, y + renderBlock); row += 1) {
        frame.fill(luma, row * width + x, row * width + x1);
      }
    }
  }

  const chromaWidth = width / 2;
  const chromaHeight = height / 2;
  const chromaTextureCell = textureCell / 2;
  const chromaRenderBlock = renderBlock / 2;
  const chromaCellsX = Math.ceil(chromaWidth / chromaTextureCell);
  const chromaCellsY = Math.ceil(chromaHeight / chromaTextureCell);
  const chromaShiftPixels = frameId * chromaRenderBlock;
  for (let plane = 0; plane < 2; plane += 1) {
    const planeStart = ySize + plane * chromaWidth * chromaHeight;
    for (let y = 0; y < chromaHeight; y += chromaRenderBlock) {
      for (let x = 0; x < chromaWidth; x += chromaRenderBlock) {
        const worldX = Math.floor((x + chromaShiftPixels) / chromaTextureCell) % chromaCellsX;
        const worldY = Math.floor((y + chromaShiftPixels) / chromaTextureCell) % chromaCellsY;
        const chroma = 88 + (
          mix32(worldX + worldY * chromaCellsX + plane * 0x45d9f3b) % 81
        );
        const x1 = Math.min(chromaWidth, x + chromaRenderBlock);
        for (let row = y; row < Math.min(chromaHeight, y + chromaRenderBlock); row += 1) {
          frame.fill(chroma, planeStart + row * chromaWidth + x, planeStart + row * chromaWidth + x1);
        }
      }
    }
  }
}

function mix32(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function validateDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 288 || height < 176) {
    throw new Error("marker requires an integer frame size of at least 288x176");
  }
  if ((width & 1) || (height & 1)) throw new Error("YUV420p dimensions must be even");
}
