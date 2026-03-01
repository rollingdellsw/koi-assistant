#!/usr/bin/env node
/**
 * koi-sign.js - Node.js signature generator for Koi skills
 * Guarantees 100% hash parity with Chrome Extension Web Crypto API
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
let pubKeyPath, privKeyPath, targetPath;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pub-key') pubKeyPath = args[++i];
  else if (args[i] === '--priv-key') privKeyPath = args[++i];
  else targetPath = args[i];
}

if (!privKeyPath || !targetPath) {
  console.error("Usage: node koi-sign.js --pub-key <pub.pem> --priv-key <priv.pem> <target-folder-or-js-file>");
  process.exit(1);
}

// Helper matching browser's isTextFile logic
function isTextFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ['.txt', '.md', '.json', '.csv', '.js', '.html', '.css', '.xml', '.ts'].includes(ext);
}

// 1. Parse URL Patterns (Matches awk / browser logic exactly)
function parseUrlPatterns(skillMd) {
  const patterns = [];
  const lines = skillMd.split('\n');
  let inPatterns = false;
  for (const line of lines) {
    if (/^url-patterns:/.test(line)) {
      inPatterns = true;
      continue;
    }
    if (inPatterns) {
      const match = line.match(/^\s*-\s*["']?([^"'\r]+)["']?/);
      if (match) patterns.push(match[1]);
      else if (line.trim() !== '') inPatterns = false;
    }
  }
  return patterns;
}

function verifySignature(hashHex, signatureBase64) {
  if (pubKeyPath && fs.existsSync(pubKeyPath)) {
    const verify = crypto.createVerify('SHA256');
    verify.update(hashHex, 'utf8');
    const isValid = verify.verify(fs.readFileSync(pubKeyPath), signatureBase64, 'base64');
    if (isValid) console.log("✅ Signature successfully verified against public key!");
    else console.error("❌ Error: Signature verification failed!");
  }
}

try {
  const stats = fs.statSync(targetPath);

  // --- STANDALONE FILE SIGNING (Global Guardrails) ---
  if (stats.isFile()) {
    if (!targetPath.endsWith('.js')) {
      console.error("Only .js files are supported for standalone signing.");
      process.exit(1);
    }
    let content = fs.readFileSync(targetPath, 'utf-8');

    // Strip existing signature if present to get original hash
    content = content.replace(/\n\/\/ @koi-signature: [A-Za-z0-9+/=]+[\r\n]*$/, '');

    const hashHex = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    console.log(`Payload SHA-256 Hash: ${hashHex}`);

    const sign = crypto.createSign('SHA256');
    sign.update(hashHex, 'utf8');
    const signatureBase64 = sign.sign(fs.readFileSync(privKeyPath), 'base64');

    const signedContent = content + `\n// @koi-signature: ${signatureBase64}\n`;
    fs.writeFileSync(targetPath, signedContent);
    console.log(`Signature appended to: ${targetPath}`);

    verifySignature(hashHex, signatureBase64);
    process.exit(0); // Exit cleanly instead of using illegal 'return'
  }

  // --- FOLDER SIGNING (Skills) ---
  const skillMdPath = path.join(targetPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    console.error(`Error: SKILL.md not found in ${targetPath}`);
    process.exit(1);
  }
  const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8');
  const contentParts = [skillMdContent];

  // URL Patterns
  const urlPatterns = parseUrlPatterns(skillMdContent);
  urlPatterns.sort().forEach(p => contentParts.push(`url-pattern:${p}`));

  // 3. Scripts
  const scriptsDir = path.join(targetPath, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir).filter(f => !fs.statSync(path.join(scriptsDir, f)).isDirectory());
    files.sort().forEach(f => {
      const content = fs.readFileSync(path.join(scriptsDir, f), 'utf-8');
      contentParts.push(`script:${f}:${content}`);
    });
  }

  // 4. MCP Scripts
  const mcpDir = path.join(targetPath, 'mcp');
  if (fs.existsSync(mcpDir)) {
    const files = fs.readdirSync(mcpDir).filter(f => f.endsWith('.js') && !fs.statSync(path.join(mcpDir, f)).isDirectory());
    files.sort().forEach(f => {
      const content = fs.readFileSync(path.join(mcpDir, f), 'utf-8');
      contentParts.push(`mcp:${f}:${content}`);
    });
  }

  // 5. Resources
  const resourcesDir = path.join(targetPath, 'resources');
  if (fs.existsSync(resourcesDir)) {
    const files = fs.readdirSync(resourcesDir).filter(f => !fs.statSync(path.join(resourcesDir, f)).isDirectory());
    files.sort().forEach(f => {
      let content;
      if (isTextFile(f)) {
        content = fs.readFileSync(path.join(resourcesDir, f), 'utf-8');
      } else {
        content = fs.readFileSync(path.join(resourcesDir, f)).toString('base64');
      }
      contentParts.push(`resource:${f}:${content}`);
    });
  }

  // 5. Generate exact same payload as Chrome
  const payload = contentParts.join('\n');
  const hashHex = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  console.log(`Payload SHA-256 Hash: ${hashHex}`);

  // 6. Sign the hash hex string using ECDSA P-256
  const sign = crypto.createSign('SHA256');
  sign.update(hashHex, 'utf8');
  const signatureBase64 = sign.sign(fs.readFileSync(privKeyPath), 'base64');

  const sigPath = path.join(targetPath, 'skill.sig');
  fs.writeFileSync(sigPath, signatureBase64 + '\n');
  console.log(`Signature written to: ${sigPath}`);

  // 7. Verify
  verifySignature(hashHex, signatureBase64);

} catch (error) {
  console.error("Failed to sign skill:", error.message);
  process.exit(1);
}
