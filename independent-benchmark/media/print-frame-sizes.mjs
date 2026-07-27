#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import {
  DEFAULT_MEDIA,
  runTimestampedSource,
  startAnnexBEncoder,
} from "./codec.mjs";

const frames = Number(process.argv[2] ?? "60");
if (!Number.isSafeInteger(frames) || frames <= 0) {
  throw new Error("frames must be a positive integer");
}

const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "benchmark-h264-"));
const encodedPath = path.join(temporaryDirectory, "benchmark.h264");

try {
  const encoder = startAnnexBEncoder({
    ...DEFAULT_MEDIA,
    sourceProfile: "translated-texture-v1",
    strictCbr: true,
  });
  const encodedFile = fs.createWriteStream(encodedPath);
  encoder.output.pipe(encodedFile);
  const encodedFileFinished = finished(encodedFile);

  const source = await runTimestampedSource(encoder.input, {
    ...DEFAULT_MEDIA,
    frames: frames + 1,
    sourceProfile: "translated-texture-v1",
  });
  encoder.input.end();
  const [code] = await once(encoder.process, "exit");
  await encodedFileFinished;

  if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
  if (source.skipped !== 0) throw new Error(`source skipped ${source.skipped} frames`);

  console.log("packet,total_bytes,keyframe");
  execFileSync("ffprobe", [
    "-v", "error",
    "-f", "h264",
    "-select_streams", "v:0",
    "-show_entries", "packet=size,flags",
    "-of", "csv=p=1",
    encodedPath,
  ], { stdio: "inherit" });
} finally {
  await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
}
