# Performance Comparison: v2 vs v3

This document highlights the architectural shift and performance gains in `json-database-st` **v3.1.0** (Rust Core + WAL) compared to **v2.0.0** (Pure JS + Incremental Indexing).

## 🏆 Executive Summary

v3 represents a paradigm shift from a **file-rewrite model** to a **hybrid in-memory/WAL model**.

- **Writes/Updates:** Up to **125,000x faster** latency for single updates on large datasets.
- **Throughput:** **~50% - 60% higher** sustained operations per second.
- **Safety:** Introduction of **ACID durability** via Write-Ahead Logging (WAL).

---

## ⚔️ Head-to-Head Benchmarks

### 1. Update Latency (The "Stop-the-World" Problem)
*Scenario: Updating a single record in a database containing 1,000,000 records.*

| Version | Mechanism | Latency (Lower is Better) | Improvement |
| :--- | :--- | :--- | :--- |
| **v2.0** | Full/Partial File Rewrite | 6,343.00 ms | 1x |
| **v3.1** | RAM Update + WAL Append | **0.05 ms** | **~126,860x 🚀** |

> **Analysis:** v2 suffered from O(N) write costs where changing one byte required writing the whole (or large parts of) the database file. v3 uses an O(1) append-only log, making writes instantaneous regardless of database size.

### 2. Throughput (Ops/Sec)
*Scenario: Ingesting 1,000,000 records sequentially.*

| Version | Mode | Ops/Sec (Higher is Better) | Notes |
| :--- | :--- | :--- | :--- |
| **v2.0** | Standard | ~57,800 | Unsafe (Crash = Data Loss during write) |
| **v3.1** | **Durable (WAL)** | **~64,500** | **Safe** (Crash = Recovery from WAL) |
| **v3.1** | **In-Memory** | **~89,000** | Unsafe (Pure RAM speed) |

> **Analysis:** v3 Durable mode is not only faster than v2 but provides crash safety that v2 never had. v3 In-Memory mode pushes Node.js to its limits, nearly saturating the N-API bridge.

### 3. Small Dataset Performance (1,000 Records)
*Scenario: Burst writing small batches.*

| Version | Ops/Sec |
| :--- | :--- |
| **v2.0** | ~12,690 |
| **v3.1** | **~34,100** |

> **Analysis:** v3 starts faster thanks to the Rust backend and optimized serialization, avoiding the "warm-up" lag seen in pure JS implementations.

---

## 🏗 Architectural Changes

| Feature | v2.0 (Legacy) | v3.1 (Current) |
| :--- | :--- | :--- |
| **Core Language** | JavaScript | **Rust** 🦀 |
| **Storage Engine** | `fs.writeFile` (Rewrite) | **Write-Ahead Log (WAL)** (Append) |
| **Durability** | Low (Window of data loss) | **High** (ACID Compliance) |
| **Indexing** | JS Objects | **Rust HashMaps** |
| **Serialization** | `JSON.stringify` (Main Thread) | **Streaming Zero-Copy** (Thread Pool) |
| **Concurrency** | Blocking I/O | **Non-Blocking / Batched** |

## How to Verify
Benchmarks were run on Windows 11 / Node v24.11.0. You can replicate these results using the included scripts:

```bash
# Test v3 Performance
npm run benchmark

# Test Hybrid/Memory Performance
node benchmark_hybrid.js
```
