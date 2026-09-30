import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ACP_DIST_DIR lets parallel UI builds each serve their own bundle.
const DIST_DIR = process.env.ACP_DIST_DIR ? path.resolve(process.env.ACP_DIST_DIR) : path.resolve(__dirname, '../dist');

const handle = await startServer({ staticDir: DIST_DIR });
const { port, token, lan } = handle;

console.log(`\n======================================================`);
console.log(`  🚀 CodePit server running:`);
console.log(`  👉 Local:   ${handle.url}`);
for (const ip of lan.addresses) {
  console.log(`  👉 Network: http://${ip}:${port}?token=${token}`);
}
for (const { address, error } of lan.errors) {
  console.log(`  ⚠️  Network: ${address} unavailable (${error})`);
}
if (!lan.enabled) {
  console.log(
    lan.lockedReason
      ? `  🔒 LAN access disabled (HOST=${lan.host}).`
      : `  🔒 LAN access off. Turn it on from the LAN access dialog, or start with ACP_LAN=1.`
  );
}
console.log(`  🔑 Token:   ${token}`);
console.log(`======================================================\n`);

let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  console.log('\n[codepit] Shutting down...');
  // close() ends the agents first; don't let a stuck socket hold the process open
  void handle.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
