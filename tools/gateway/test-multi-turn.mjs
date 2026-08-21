import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { GatewayClient } from './test-sandbox-gateway.mjs';

async function run() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-multiturn-'));
  console.log('Host repo:', repo);

  // 1. Init host repo (Baseline)
  execSync(`git init -q . && git config init.defaultBranch main && echo "v1" > file.txt && git add file.txt && git -c user.email=test@test -c user.name=test commit -qm "init"`, { cwd: repo });
  const initialBase = execSync(`git rev-parse HEAD`, { cwd: repo }).toString().trim();

  const client = new GatewayClient('ws://localhost:8080', 'sandbox');
  await client.connect();
  await client.rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1' }, capabilities: {} });
  client.notify('notifications/initialized');

  await client.callTool('sandbox_open_project', { path: repo });

  // ==========================================
  // Turn 1
  // ==========================================
  console.log('\n--- Turn 1 ---');
  // AI gets turn base
  const t1BaseRes = await client.callTool('sandbox_exec', { command: `git rev-parse HEAD` });
  const t1Base = t1BaseRes.stdout.trim();
  console.log('Turn 1 AI Base:', t1Base);

  // AI edits and commits
  await client.callTool('sandbox_exec', { command: `echo "v2" > file.txt && git add file.txt && git -c user.email=ai@test -c user.name=ai commit -qm "turn1"` });
  let outboxInfo = await client.callTool('sandbox_info');
  await client.callTool('sandbox_exec', { command: `rm -f "$KOI_OUTBOX"/*.patch && git format-patch -o "$KOI_OUTBOX" ${t1Base}..HEAD` });

  let patches1 = fs.readdirSync(outboxInfo.outbox).filter(f => f.endsWith('.patch'));
  console.log('Turn 1 exported patches:', patches1);

  // Host applies Turn 1 patch
  execSync(`git am ${path.join(outboxInfo.outbox, patches1[0])}`, { cwd: repo });
  const hostHeadAfterT1 = execSync(`git rev-parse HEAD`, { cwd: repo }).toString().trim();
  console.log('Host applied patch 1 successfully. Host HEAD:', hostHeadAfterT1);

  // ==========================================
  // Turn 2
  // ==========================================
  console.log('\n--- Turn 2 ---');
  // At the start of Turn 2, calling any mutating or sync tool updates the overlay from the host.
  // When AI checks `git rev-parse HEAD`, it should see the Host's updated commit!
  const t2BaseRes = await client.callTool('sandbox_exec', { command: `git rev-parse HEAD` });
  const t2Base = t2BaseRes.stdout.trim();
  console.log('Turn 2 AI Base (synced from host):', t2Base);

  if (t2Base !== hostHeadAfterT1) {
    console.error(`❌ Turn 2 Base Desync: AI saw ${t2Base} but Host was at ${hostHeadAfterT1}`);
  } else {
    console.log('✅ Turn 2 Base correctly matches Host HEAD!');
  }

  // AI edits and commits
  await client.callTool('sandbox_exec', { command: `echo "v3" > file.txt && git add file.txt && git -c user.email=ai@test -c user.name=ai commit -qm "turn2"` });
  await client.callTool('sandbox_exec', { command: `rm -f "$KOI_OUTBOX"/*.patch && git format-patch -o "$KOI_OUTBOX" ${t2Base}..HEAD` });

  let patches2 = fs.readdirSync(outboxInfo.outbox).filter(f => f.endsWith('.patch')).sort();
  console.log('Turn 2 exported patches:', patches2);

  // User applies Turn 2 patches
  try {
    for (const p of patches2) {
      console.log(`Applying ${p}...`);
      execSync(`git am ${path.join(outboxInfo.outbox, p)}`, { cwd: repo, stdio: 'pipe' });
    }
    console.log('🎉 SUCCESS: Host applied Turn 2 patches cleanly without conflicts!');
  } catch (e) {
    console.error('❌ Failure: Host failed to apply Turn 2 patches!', e.message);
  }

  client.close();
}
run().catch(console.error);
