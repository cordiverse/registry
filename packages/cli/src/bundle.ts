import { PackageJson } from '@cordisjs/registry'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { exec, ExecOptions } from 'node:child_process'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { build, BuildFailure, BuildOptions } from 'esbuild'
import { createRequire } from 'node:module'
import { Dict } from 'cosmokit'
import { codeFrameColumns } from '@babel/code-frame'
import { tempDir } from './utils.ts'
import getRegistry from 'get-registry'
import parse from 'yargs-parser'

function spawnAsync(args: string[], options?: ExecOptions) {
  const child = exec(args.join(' '), options)
  return new Promise<number>((resolve, reject) => {
    child.on('close', resolve)
  })
}

const endpoint = 'https://registry.cordis.moe'

export const registry = await getRegistry()

export async function prepare(name: string, version: string) {
  const cwd = resolve(tempDir, name)
  await rm(cwd, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(cwd + '/index.js', fields[name] ? [
    `import mod from '${name}';`,
    ...fields[name].map((field) => `export const ${field} = mod.${field};`),
  ].join('\n') : '')
  await writeFile(cwd + '/package.json', JSON.stringify({
    dependencies: {
      [name]: version,
    },
  }))

  const code = await spawnAsync(['npm', 'install', '--legacy-peer-deps', '--registry', registry], { cwd })
  if (code) throw new Error('npm install failed')
}

function resolveVendor(name: string) {
  const scope = /^@[^/]+\//.exec(name)?.[0] ?? ''
  const head = scope + name.slice(scope.length).split('/', 1)
  let tail = name.slice(head.length)
  if (!tail.endsWith('.js')) tail += '/index.js'
  return endpoint + '/modules/' + (vendors[head] ?? head) + tail
}

export async function bundle(name: string, verified = false) {
  const cwd = resolve(tempDir, name)
  const require = createRequire(cwd + '/package.json')
  const meta: PackageJson = require(join(cwd, 'node_modules', name, 'package.json'))
  const basedir = join(cwd, 'node_modules', name)

  // check peer dependencies
  const peerDeps = Object.keys(meta.peerDependencies || {})
  for (const key of peerDeps) {
    if (key in vendors) continue
    if (key.includes('cordis-plugin-') || key.startsWith('@cordisjs/plugin-')) continue
    return 'invalid peer dependency'
  }
  const external = new Set([...Object.keys(vendors), ...peerDeps])

  let size = 0
  const matrix: BuildOptions[] = []
  const exports: Dict<string> = Object.create(null)
  const outdir = resolve(__dirname, '../../../dist/modules', name)
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  function addBuild(entry: string, srcFile: string) {
    exports[srcFile] = join(outdir, entry)
    matrix.push({
      entryPoints: { [entry]: srcFile },
      bundle: true,
      minify: require.main !== module,
      drop: ['console', 'debugger'],
      write: false,
      charset: 'utf8',
      platform: 'browser',
      target: 'esnext',
      format: 'esm',
      logLevel: 'silent',
      define: {
        '__dirname': 'import.meta.url',
        'global': 'globalThis',
        'process.env.KOISHI_ENV': JSON.stringify('browser'),
        'process.env.KOISHI_REGISTRY': JSON.stringify(endpoint),
        'process.env.KOISHI_BASE': JSON.stringify(endpoint + '/modules/' + name),
      },
      inject: globals.includes(name) ? [] : injects,
      plugins: [{
        name: 'external',
        setup(build) {
          const escape = (text: string) => text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
          const filter = new RegExp(`^(node:)?(${[...external].map(escape).join('|')})(/.+)?$`)
          const { entryPoints } = build.initialOptions
          const currentEntry = Object.values(entryPoints)[0]

          build.onResolve({ filter }, (args) => {
            if (args.path === name) return null
            if (args.path.startsWith('node:')) {
              args.path = args.path.slice(5)
            }
            return args.kind === 'require-call'
              ? { path: args.path, namespace: 'external' }
              : { external: true, path: resolveVendor(args.path) }
          })

          build.onResolve({ filter: /.*/, namespace: 'external' }, (args) => ({
            external: true,
            path: resolveVendor(args.path),
          }))

          build.onLoad({ filter: /.*/, namespace: 'external' }, (args) => ({
            loader: 'ts',
            contents: commonjs.includes(args.path)
              ? `import mod from ${JSON.stringify(args.path)}; export = mod;`
              : `export * from ${JSON.stringify(args.path)};`,
          }))

          build.onResolve({ filter: /^\./, namespace: 'file' }, async (args) => {
            const { path } = await build.resolve(args.path, {
              namespace: 'relative',
              importer: args.importer,
              resolveDir: args.resolveDir,
              kind: args.kind,
            })
            if (currentEntry === path || !exports[path]) return null
            // native ESM import should preserve extensions
            if (!exports[path]) return null
            const outDir = dirname(exports[currentEntry])
            let relpath = relative(outDir, exports[path])
            if (!relpath.startsWith('.')) relpath = './' + relpath
            return { path: relpath, external: true }
          })
        },
      }],
    })
  }

  async function addExport(exports: string, pattern = '.') {
    const ext = extname(pattern)
    if (!ext) {
      pattern += '/index.js'
    } else if (ext !== '.js') {
      return copy(resolve(basedir, exports), resolve(outdir, pattern))
    }
    if (pattern.startsWith('./')) pattern = pattern.slice(2)
    if (exports.includes('*')) return // TODO support glob
    addBuild(pattern, resolve(basedir, exports))
  }

  async function addConditionalExport(exports: PackageJson.Exports, pattern = '.', strict = false) {
    if (typeof exports === 'string') {
      return addExport(exports, pattern)
    }
    for (const key of ['browser', 'import', 'default']) {
      if (exports[key]) {
        return addConditionalExport(exports[key], pattern)
      }
    }
    for (const pattern in exports) {
      if (!pattern.startsWith('.')) continue
      if (strict && pattern !== '.') continue
      await addConditionalExport(exports[pattern], pattern)
    }
  }

  if (fields[name]) {
    addBuild('index.js', resolve(cwd, 'index.js'))
  } else if (meta.exports) {
    await addConditionalExport(meta.exports, '.', !multiEntry.includes(name))
  } else if (typeof meta.browser === 'string') {
    await addExport(meta.browser)
  } else if (typeof meta.module === 'string') {
    await addExport(meta.module)
  } else if (typeof meta.main === 'string') {
    await addExport(meta.main)
  } else {
    await addExport('index.js')
  }

  function isBuildFailure(e: any): e is BuildFailure {
    return !!e?.errors && !!e?.warnings
  }

  let hasError = false
  for (const options of matrix) {
    try {
      const result = await build(options)
      const { contents } = result.outputFiles[0]
      size += contents.byteLength
      const name = Object.keys(options.entryPoints)[0]
      const filename = resolve(outdir, name)
      await mkdir(dirname(filename), { recursive: true })
      await writeFile(filename, contents)
      if (require.main === module) console.log(filename)
    } catch (e) {
      if (!isBuildFailure(e)) throw e
      hasError = true
      for (const error of e.errors) {
        if (!error.location) {
          console.log(error.text)
          continue
        }
        const { file, line, column } = error.location
        console.log(`File: ${file}:${line}:${column}`)
        const source = await readFile(file, 'utf8')
        const formatted = codeFrameColumns(source, {
          start: { line, column },
        }, {
          highlightCode: true,
          message: error.text,
          forceColor: true,
        })
        console.log(formatted)
      }
    }
  }

  if (hasError) return 'bundle failed'

  if (!verified && size > 1024 * 1024) {
    await rm(outdir, { recursive: true, force: true })
    return 'size exceeded'
  }

  async function copy(source: string, target: string) {
    const buffer = await readFile(source)
    const filename = resolve(outdir, target)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, buffer)
  }

  // TODO public
}

if (require.main === module) {
  const argv = parse(process.argv.slice(2))
  if (!argv._.length) throw new Error('package name required')
  const name = '' + argv._[0]
  Promise.resolve().then(async () => {
    await prepare(name, 'latest')
    console.log(await bundle(name, true))
  })
}
