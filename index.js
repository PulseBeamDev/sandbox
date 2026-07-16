import * as pb from "./pulsebeam.js";
import * as cf from "./cloudflare.js";

pb.spawnDataPublisher();
pb.spawnDataSubscriber();

// const { sessionId } = await cf.spawnDataPublisher();
// cf.spawnDataSubscriber(sessionId);
