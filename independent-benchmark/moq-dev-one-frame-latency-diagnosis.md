# moq.dev self-hosted one-frame latency diagnosis

Status: root cause reproduced and validated across all three GCP corridors.

## Symptom

With the same 1280×720p30 H.264 source and matched GCP endpoints, the accepted
self-hosted moq.dev runs were consistently about one frame slower than the
self-hosted moq-rs path at P50:

| Corridor | moq-rs P50 | moq.dev P50 | Difference |
| --- | ---: | ---: | ---: |
| California → Virginia | 179.688 ms | 217.778 ms | 38.091 ms |
| California → Frankfurt | 221.208 ms | 262.452 ms | 41.244 ms |
| California → Tokyo | 196.607 ms | 235.010 ms | 38.403 ms |

One 30 fps frame is 33.333 ms. The remaining 4.8–7.9 ms is consistent with the
different mux/export and relay implementations.

## Root cause

The benchmark already selected `moq export ... fmp4 --fragment-duration 0ms`,
which moq.dev documents as one fragment per frame. In pinned revision
`b0115deeed82792a4dee41bb783b580fa03fbbfe`, however,
`moq-mux/src/container/fmp4/export.rs` tests whether the existing buffer should
flush *before* appending the newly received frame.

In zero-duration mode this sequence is:

1. Frame N arrives while the buffer is empty.
2. `should_flush` returns false because the buffer is empty.
3. Frame N is appended and the exporter waits for more work.
4. Frame N+1 arrives; only then does `should_flush` return true and emit frame N.

The importer, relay, and MoQ frame itself are not imposing that delay. The delay
is introduced in the subscriber-side fMP4 exporter.

The same buffer-before-append sequence is still present on official moq.dev
`main` at `24f8528ed31c87581b217c3babc987f8a172a942` (2026-07-19), so this is not
only an artifact of the pinned benchmark revision:
<https://github.com/moq-dev/moq/blob/24f8528ed31c87581b217c3babc987f8a172a942/rs/moq-mux/src/container/fmp4/export.rs#L242-L263>

## Reproduction and fix

A focused live-stream regression test keeps the producer open after its first
frame and asks a zero-duration exporter for the first media fragment. On the
unmodified pinned revision it failed with:

```text
zero-duration mode waited for a successor frame: Elapsed(())
```

The patch emits the received frame immediately when the fragment cap is zero,
using the sample duration already carried by CMAF (or the existing single-frame
fallback for duration-less sources). After the patch:

- the new regression test passes;
- all 360 `moq-mux` tests pass;
- the patch is recorded in `patches/moq-dev-immediate-zero-fragment.patch`.

## Cross-region validation

The patched exporter was rebuilt from pinned revision
`b0115deeed82792a4dee41bb783b580fa03fbbfe` on each benchmark node. Every remote
manifest recorded patch SHA-256
`5217f852af77ea60591a9698ce4c634f6c97a456ca153f1c996927015acb8897`.
The same three-node, sequential GCP topology and qualified 720p30, 4 Mbps,
strict-CBR workload were then rerun for three five-minute trials per corridor:

| Corridor | Unpatched P50 | Patched P50 | Reduction | Patched P99 |
| --- | ---: | ---: | ---: | ---: |
| California → Virginia | 217.778 ms | 184.426 ms | 33.352 ms | 191.927 ms |
| California → Frankfurt | 262.452 ms | 230.038 ms | 32.414 ms | 238.144 ms |
| California → Tokyo | 235.010 ms | 201.700 ms | 33.310 ms | 209.273 ms |

Across the nine patched trials, 81,000 of 81,000 measured frames arrived. There
were zero measured-frame losses, duplicates, out-of-order frames, or invalid
markers; all resource analyses were accepted. Each trial recorded one
presentation gap above 100 ms, but none above 250 ms. Maximum reported clock
offset remained below 0.010 ms.

The P50 reductions are 32.4–33.4 ms against a 33.333 ms frame interval. This
closes the original anomaly: the extra media latency was the zero-duration fMP4
exporter's successor-frame dependency, not an inherent moq.dev relay penalty.
