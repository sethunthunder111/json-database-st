const JSONDatabase = require('./JSONDatabase');
const fs = require('fs');
const path = require('path');

// ANSI Colors for the console
const C = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
};

const DB_FILE = 'bench_test.json';

async function runBenchmarks() {
    console.log(`${C.cyan}========================================`);
    console.log(`   🚀 ST DATABASE PERFORMANCE TEST 🚀`);
    console.log(`========================================${C.reset}\n`);

    // 0. Cleanup previous run
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    if (fs.existsSync(DB_FILE + '.tmp')) fs.unlinkSync(DB_FILE + '.tmp');

    // 1. Initialization
    console.log(`${C.yellow}[1] Initializing Database...${C.reset}`);
    const db = new JSONDatabase(DB_FILE, {
        saveDelay: 50, // 50ms debounce
        indices: [{ name: 'user_email', path: 'users', field: 'email' }]
    });
    
    // Wait for init
    await db.set('meta', { start: Date.now() });
    console.log(`${C.green}✔ Database Ready.${C.reset}\n`);

    // ---------------------------------------------------------
    // TEST 2: BURST WRITES (Debounce Test)
    // ---------------------------------------------------------
    console.log(`${C.yellow}[2] Testing Burst Writes (10,000 operations)...${C.reset}`);
    const startWrite = process.hrtime.bigint();
    
    // We simulate a loop. In a normal file DB, this would take 30+ seconds.
    // Here, it should be near instant because it hits RAM and debounces the disk write.
    const COUNT = 10000;
    for (let i = 0; i < COUNT; i++) {
        // We don't await here to simulate rapid fire events (like server requests)
        // But we push promises to array to measure API acknowledgment time
        db.set(`users.u${i}`, { 
            id: i, 
            name: `User ${i}`, 
            email: `user${i}@st-empire.com`,
            balance: 100 
        });
    }
    
    // Force a wait for the last operation to be acknowledged by the API
    await db.set('meta.end_write', true);

    const endWrite = process.hrtime.bigint();
    const writeTime = Number(endWrite - startWrite) / 1e6; // Convert to ms

    console.log(`   ➜ Processed ${COUNT} writes in: ${C.cyan}${writeTime.toFixed(2)}ms${C.reset}`);
    console.log(`   ➜ Speed: ${C.green}${Math.round(COUNT / (writeTime/1000))} ops/sec${C.reset} (Virtual Speed)`);
    console.log(`   (Note: Disk writes are happening in the background)\n`);

    // ---------------------------------------------------------
    // TEST 3: ATOMIC MATH (Concurrency Test)
    // ---------------------------------------------------------
    console.log(`${C.yellow}[3] Testing Atomic Math (1,000 concurrent adds)...${C.reset}`);
    
    await db.set('wallet', 0);
    const mathPromises = [];
    for(let i=0; i<1000; i++) {
        mathPromises.push(db.add('wallet', 1));
    }
    await Promise.all(mathPromises);
    
    const finalWallet = await db.get('wallet');
    if (finalWallet === 1000) {
        console.log(`${C.green}✔ SUCCESS: Wallet balance is 1000.${C.reset}`);
    } else {
        console.log(`${C.red}✘ FAIL: Wallet balance is ${finalWallet} (Expected 1000). Race condition detected!${C.reset}`);
    }
    console.log("");

    // ---------------------------------------------------------
    // TEST 4: READ PERFORMANCE (O(n) vs O(1))
    // ---------------------------------------------------------
    console.log(`${C.yellow}[4] Testing Read Speeds (Dataset: 10,000 records)...${C.reset}`);
    
    const targetEmail = `user9999@st-empire.com`; // The very last user
    
    // A. Standard Find (Scanning the array/object)
    const startScan = process.hrtime.bigint();
    await db.find('users', u => u.email === targetEmail);
    const endScan = process.hrtime.bigint();
    const scanTime = Number(endScan - startScan) / 1e6;

    // B. Indexed Find (Hash Map Lookup)
    const startIndex = process.hrtime.bigint();
    await db.findByIndex('user_email', targetEmail);
    const endIndex = process.hrtime.bigint();
    const indexTime = Number(endIndex - startIndex) / 1e6;

    console.log(`   ➜ Standard Scan (O(n)):  ${C.red}${scanTime.toFixed(4)}ms${C.reset}`);
    console.log(`   ➜ Indexed Look (O(1)):  ${C.green}${indexTime.toFixed(4)}ms${C.reset}`);
    
    const improvement = (scanTime / indexTime).toFixed(1);
    console.log(`   🔥 Indexing is ${C.cyan}${improvement}x faster${C.reset}!\n`);

    // ---------------------------------------------------------
    // CLEANUP
    // ---------------------------------------------------------
    console.log(`${C.yellow}[5] Waiting for final disk flush...${C.reset}`);
    
    // Wait for the debounce timer (50ms) + a bit of buffer
    await new Promise(r => setTimeout(r, 1000));
    
    const stats = fs.statSync(DB_FILE);
    const sizeMB = stats.size / 1024 / 1024;
    
    console.log(`${C.green}✔ All Tests Complete.${C.reset}`);
    console.log(`   Final DB Size: ${sizeMB.toFixed(2)} MB`);
    
    // Clean up
    fs.unlinkSync(DB_FILE);
    if (fs.existsSync(DB_FILE + '.tmp')) fs.unlinkSync(DB_FILE + '.tmp');
    if (fs.existsSync(DB_FILE + '.bak')) fs.unlinkSync(DB_FILE + '.bak');
}

runBenchmarks().catch(console.error);