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
| **v3.1** | RAM Update + WAL Append | **0.005 ms** | **~1,200,000x 🚀** |

> **Analysis:** v2 suffered from O(N) write costs. v3 uses an O(1) append-only log, making writes instantaneous regardless of database size.

### 2. Throughput (Ops/Sec)
*Scenario: Ingesting 1,000,000 records sequentially.*

| Version | Mode | Ops/Sec (Higher is Better) | Notes |
| :--- | :--- | :--- | :--- |
| **v2.0** | Standard | ~12,000 | Unsafe (Crash = Data Loss) |
| **v3.1** | **Durable (WAL)** | **~38,514** | **Safe** (Crash = Recovery from WAL) |

> **Analysis:** v3 Durable mode provides crash safety with massive throughput.

### 3. Read Performance
*Scenario: Reading by index (Linear Scan in Rust).*

| Dataset Size | Read Time |
| :--- | :--- |
| 1,000 | 0.54 ms |
| 10,000 | 5.92 ms |
| 100,000 | 18.82 ms |
| 1,000,000 | 324.76 ms |

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
