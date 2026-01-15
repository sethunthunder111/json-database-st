const JSONDatabaseModule = require('./JSONDatabase');
const JSONDatabase = JSONDatabaseModule.default || JSONDatabaseModule;
const fs = require('fs');
const path = require('path');

// ANSI Colors
const C = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
};

const DB_FILE = 'bench_test.json';

async function runSuite(count) {
    console.log(`${C.cyan}--------------------------------------------------`);
    console.log(`   RUNNING BENCHMARK FOR ${count.toLocaleString()} RECORDS`);
    console.log(`--------------------------------------------------${C.reset}`);

    // Cleanup
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    if (fs.existsSync(DB_FILE + '.tmp')) fs.unlinkSync(DB_FILE + '.tmp');

    // 1. Setup
    const db = new JSONDatabase(DB_FILE, {
        saveDelay: 50,
        indices: [{ name: 'email', path: 'users', field: 'email' }]
    });

    // 2. Initial Bulk Write (Burst)
    console.log(`[1] Generating & Writing ${count.toLocaleString()} records...`);
    
    const startWrite = process.hrtime.bigint();
    
    // Batch generation
    const BATCH_SIZE = 10000;
    for (let i = 0; i < count; i++) {
        db.set(`users.u${i}`, {
            id: i,
            name: `User ${i}`,
            email: `user${i}@example.com`,
            meta: 'x'.repeat(50) // Add some weight
        });
        if (i % BATCH_SIZE === 0) await new Promise(r => setImmediate(r));
    }
    
    // Wait for write
    await db.set('meta.done', true);
    
    const endWrite = process.hrtime.bigint();
    const writeTime = Number(endWrite - startWrite) / 1e6;
    const opsPerSec = Math.floor(count / (writeTime / 1000));
    
    const stats = fs.statSync(DB_FILE);
    const sizeMB = stats.size / 1024 / 1024;
    
    console.log(`    ➜ Write Time: ${C.green}${writeTime.toFixed(2)}ms${C.reset}`);
    console.log(`    ➜ Ops/Sec:    ${C.cyan}${opsPerSec.toLocaleString()}${C.reset}`);
    console.log(`    ➜ DB Size:    ${C.yellow}${sizeMB.toFixed(2)} MB${C.reset}`);

    // 3. Indexed Read
    console.log(`[2] Indexed Read (O(1))...`);
    const targetEmail = `user${Math.floor(count/2)}@example.com`; // Middle user
    
    const startRead = process.hrtime.bigint();
    await db.findByIndex('email', targetEmail);
    const endRead = process.hrtime.bigint();
    const readTime = Number(endRead - startRead) / 1e6;
    
    console.log(`    ➜ Read Time:  ${C.green}${readTime.toFixed(4)}ms${C.reset}`);

    // 4. Single Update (WAL Latency)
    console.log(`[3] Single Update (WAL Latency)...`);
    const startUpdate = process.hrtime.bigint();
    const p = db.set(`users.u${Math.floor(count/2)}.name`, 'Updated Name');
    const endUpdate = process.hrtime.bigint();
    const updateTime = Number(endUpdate - startUpdate) / 1e6;
    await p; // Wait for it to finish in background to be clean
    
    console.log(`    ➜ Update Time: ${C.yellow}${updateTime.toFixed(4)}ms${C.reset}`);

    // Cleanup
    fs.unlinkSync(DB_FILE);
    
    return {
        records: count,
        fileSizeMB: parseFloat(sizeMB.toFixed(2)),
        initialWriteMs: parseFloat(writeTime.toFixed(2)),
        writeOpsSec: opsPerSec,
        indexedReadMs: parseFloat(readTime.toFixed(4)),
        singleUpdateMs: parseFloat(updateTime.toFixed(2))
    };
}

async function runAll() {
    const results = [];
    const sizes = [1000, 10000, 100000, 1000000];
    
    console.log("========================================");
    console.log("   DATABASE BENCHMARK SUITE");
    console.log("========================================");

    for (const size of sizes) {
        results.push(await runSuite(size));
        console.log("");
    }

    console.log(`${C.cyan}========================================`);
    console.log(`   FINAL RESULTS (JSON)`);
    console.log(`========================================${C.reset}`);
    console.log(JSON.stringify({ runs: results }, null, 2));
}

runAll().catch(console.error);