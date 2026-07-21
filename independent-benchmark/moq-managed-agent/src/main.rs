// Keep the managed-relay workload byte-for-byte aligned with the self-hosted
// moq-rs datagram agent while compiling it against Cloudflare's draft-14
// client libraries.
include!("../../moq-agent/src/main.rs");
