import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('./', import.meta.url);
const noise = readFileSync(new URL('src/noise.glsl', root), 'utf8');
const engine = readFileSync(new URL('src/engine.part.js', root), 'utf8');
const glue = readFileSync(new URL('src/plugin.part.js', root), 'utf8');

if (/[`\\]|\$\{/.test(noise)) {
  throw new Error('Noise GLSL contains characters that would break the JS template literal.');
}
if (!engine.includes('__NOISE_GLSL__')) {
  throw new Error('engine.part.js is missing the __NOISE_GLSL__ placeholder.');
}

const body = `(function () {\n  'use strict';\n\n${engine}\n\n${glue}\n})();\n`;
const client = body.replace('__NOISE_GLSL__', () => noise.trim());
writeFileSync(new URL('client.js', root), client);
console.log(`built client.js (${(client.length / 1024).toFixed(1)} KiB)`);
