import * as pb from "./pulsebeam.js";
import * as cf from "./cloudflare.js";

const { sessionId } = await cf.spawnDataPublisher();
cf.spawnDataSubscriber(sessionId);

pb.spawnDataPublisher();
pb.spawnDataSubscriber();

