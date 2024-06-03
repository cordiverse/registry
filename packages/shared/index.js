import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const meta = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

export const dependencies = {}
export const vendors = {}

for (let [name, request] of Object.entries(meta.dependencies)) {
  name = name.replace('@node/', '')
  if (request.startsWith('npm:')) {
    const [target] = request.slice(4).split(/(?<=.+)@/, 1)
    dependencies[target] = request.slice(4 + target.length + 1)
    vendors[name] = target
  } else {
    dependencies[name] = request
    vendors[name] = name
  }
}

export const multiEntry = [
  '@cordiverse/dns',
  '@cordiverse/fs',
  '@cordiverse/url',
  '@cordiverse/os',
]

export const globals = ['buffer', 'process']

export const commonjs = [
  'assert',
  'constants',
  'crypto',
  'events',
  'filer',
  'path',
  'process',
  'reggol',
  'stream',
  'util',
  'zlib',
]

export const fields = {
  buffer: ['Buffer', 'SlowBuffer', 'INSPECT_MAX_BYTES', 'kMaxLength'],
}

export const injects = [join(__dirname, 'globals.js')]
