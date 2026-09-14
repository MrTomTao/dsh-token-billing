/**
 * dsh-token-billing — dependency-free build.
 *
 * Two artifacts, both plain JavaScript, no bundler and no TypeScript:
 *
 *   src/host.js   -> lib/index.js    the Node half, copied verbatim (ESM)
 *   src/client.js -> lib/client.js   the browser half, wrapped in the
 *                                    `window.__ModuleLoader__.load({...})`
 *                                    closure factory the client module table
 *                                    expects (see packages/client/tsdown.client.ts
 *                                    in the harness: banner + intro + footer).
 *
 * Run with `node build.mjs`. The artifacts are committed-ready: an install
 * needs neither this script nor a network round trip beyond `zod`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const indent = line => (line === '' ? '' : `\t\t${line}`)

/** Fail loudly rather than shipping a bundle the module table cannot parse. */
function assertCommonJs(name, source) {
  const offending = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^(?:import|export)\s/.test(line))
  if (offending.length > 0) {
    throw new Error(`${name} must be CommonJS: line(s) ${offending.map(entry => entry.number).join(', ')} use import/export`)
  }
}

const host = await readFile(join(root, 'src/host.js'), 'utf8')
const client = await readFile(join(root, 'src/client.js'), 'utf8')
assertCommonJs('src/client.js', client)

const bundle = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(manifest.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  client.trimEnd().split('\n').map(indent).join('\n'),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib/index.js'), host)
await writeFile(join(root, 'lib/client.js'), bundle)

console.log(`built ${manifest.name}: lib/index.js (${host.length} B), lib/client.js (${bundle.length} B)`)
