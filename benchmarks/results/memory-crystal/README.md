# Memory Crystal Benchmark Results

`latest.json` is generated from the deterministic seeded retrieval harness:

```bash
node scripts/bench-memory-crystal.mjs --boundary retrieval_seeded --out benchmarks/results/memory-crystal/latest.json
```

This result measures the `retrieval_seeded` boundary only: fixture memories are inserted directly into isolated `convex-test` stores, then Memory Crystal's recall action is scored. It is useful evidence for retrieval, ranking, contradiction filtering, and scoped privacy behavior. It is not evidence for automatic turn extraction quality.

Cheap V1 policy:

- No paid competitor API runs.
- No large hosted latency/cost curves.
- Missing hosted credentials emit explicit `blocked_credentials` artifacts.
- Competitor rows emit explicit `not_reproduced` or `not_available` artifacts.
- `latency-cost-latest.json` records the zero-spend local sample and defers 100, 1k, 10k, and 100k sizes until budget is approved.

Hosted/direct API runs should write raw artifacts under `.crystal/benchmarks/...` unless they have been reviewed and redacted for publication.

Validate publishable artifacts with:

```bash
node scripts/validate-benchmark-artifacts.mjs --matrix
```
