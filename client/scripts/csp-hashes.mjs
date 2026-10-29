// Runs after `next build`. The static export inlines Next's hydration payload as <script> tags,
// so script-src can only drop 'unsafe-inline' once every one of them is hashed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(clientDir, 'out');

const hashes = new Set();

for (const file of readdirSync(outDir, { recursive: true })) {
  if (!file.endsWith('.html')) continue;

  const html = readFileSync(join(outDir, file), 'utf8');

  for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (body.length > 0) {
      hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    }
  }
}

const template = readFileSync(join(clientDir, 'public', '_headers'), 'utf8');
const headers = template.replace(
  /(Content-Security-Policy: .*?script-src [^;]*)'unsafe-inline'/,
  (_, before) => before + [...hashes].join(' '),
);

if (headers === template) {
  throw new Error("public/_headers has no 'unsafe-inline' in script-src to replace");
}

// Cloudflare Pages caps _headers lines at 2000 characters; past that, split the CSP into per-page rules
const longest = Math.max(...headers.split('\n').map((line) => line.length));
if (longest > 2000) {
  throw new Error(`_headers line is ${longest} characters, over the Cloudflare Pages limit of 2000`);
}

writeFileSync(join(outDir, '_headers'), headers);
console.log(`csp-hashes: ${hashes.size} inline script hashes written to out/_headers (longest line ${longest} characters)`);
