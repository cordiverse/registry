import { Awaitable, deduplicate, defineProperty, Dict, pick } from 'cosmokit'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { PackageJson, SearchObject } from './types.ts'
import { Ecosystem, Manifest } from './manifest.ts'
import glob from 'fast-glob'

type PnP = typeof import('pnpapi')

let pnp: PnP | undefined

if (process.versions.pnp) {
  try {
    pnp = createRequire(import.meta.url)('pnpapi')
  } catch {}
}

declare module 'pnpapi' {
  function getDependencyTreeRoots(): PackageLocator[]
  function getAllLocators(): PackageLocator[]
}

const LocalKey = ['name', 'version'] as const
type LocalKeys = typeof LocalKey[number]

export interface LocalObject extends Pick<SearchObject, 'shortname' | 'workspace' | 'manifest'> {
  package: Pick<PackageJson, LocalKeys>
  readme?: Dict<string | null>
  _readmeFiles?: Dict<string | Promise<string>>
}

export interface LocalScanner extends LocalScanner.Options {}

export namespace LocalScanner {
  export interface Options {
    onFailure?(reason: any, name: string): void
    onSuccess?(object: LocalObject): Awaitable<void>
  }
}

interface Locator {
  request?: string
  path: string
  workspace: boolean
}

interface Candidate extends Locator {
  package: PackageJson
}

export interface Dependency extends Partial<Candidate> {
  name: string
  request: string
}

export class LocalScanner {
  public cache: Dict<LocalObject> = Object.create(null)
  public dependencies: Dict<Dependency> = Object.create(null)
  public ecosystems: Ecosystem[] = []

  private candidates: Dict<Candidate> = Object.create(null)
  private metaDeps: Dict<string> = Object.create(null)
  private pkgTasks: Dict<Promise<LocalObject | undefined>> = Object.create(null)
  private scanTask?: Promise<Dependency[]>
  private mainTask?: Promise<LocalObject[]>
  private require: NodeRequire

  constructor(public baseDir: string, options: LocalScanner.Options = {}) {
    this.require = createRequire(baseDir + '/package.json')
    Object.assign(this, options)
  }

  async scan() {
    return (this.scanTask ||= this._scan())
  }

  private async _scan() {
    const meta = JSON.parse(await readFile(this.baseDir + '/package.json', 'utf8')) as PackageJson
    for (const key of ['dependencies']) {
      Object.assign(this.metaDeps, meta[key])
    }

    if (pnp) {
      await this.loadPlugAndPlay(pnp)
    } else {
      await this.loadNodeModules()
    }

    return Object.entries(this.metaDeps).map<Dependency>(([name, request]) => {
      return { name, request, ...this.candidates[name] }
    })
  }

  async collect() {
    return (this.mainTask ||= this._collect())
  }

  private async _collect() {
    await this.scan()

    // check for candidates
    this.ecosystems.push(Ecosystem.INIT)
    while (this.ecosystems.length) {
      const ecosystem = this.ecosystems.shift()!
      this.loadEcosystem(ecosystem)
    }

    await Promise.allSettled(Object.values(this.pkgTasks))
    return Object.values(this.cache)
  }

  async loadPlugAndPlay(pnp: PnP) {
    const locators: Dict<Locator> = Object.create(null)

    // workspaces
    if (pnp.getDependencyTreeRoots) {
      for (const locator of pnp.getDependencyTreeRoots()) {
        if (!locator.name) continue
        const info = pnp.getPackageInformation(locator)
        locators[locator.name] = {
          path: info.packageLocation,
          workspace: true,
          request: this.metaDeps[locator.name],
        }
      }
    }

    // dependencies
    for (const name in this.metaDeps) {
      if (name in locators) continue
      const path = pnp.resolveToUnqualified(name, this.baseDir)
      if (!path) continue
      locators[name] = {
        path,
        workspace: false,
        request: this.metaDeps[name],
      }
    }

    await Promise.all(Object.entries(locators).map(async ([name, locator]) => {
      try {
        const meta = await this.loadMeta(join(locator.path, 'package.json'))
        this.candidates[name] = { ...locator, package: meta }
      } catch (reason) {
        this.onFailure?.(reason, name)
      }
    }))
  }

  async loadNodeModules() {
    // scan for candidate packages (dependencies and symlinks)
    let root = this.baseDir
    const dirTasks: Promise<string[]>[] = []
    while (1) {
      dirTasks.push(this.loadDirectory(root))
      const parent = dirname(root)
      if (root === parent) break
      root = parent
    }
    const names = deduplicate((await Promise.all(dirTasks)).flat(1))
    const results = await Promise.all(names.map<Promise<Candidate | undefined>>(async (name) => {
      try {
        const filename = this.require.resolve(name + '/package.json')
        const workspace = !filename.includes('node_modules')
        return {
          path: dirname(filename),
          package: await this.loadMeta(filename),
          workspace,
          request: this.metaDeps[name],
        }
      } catch (reason) {
        this.onFailure?.(reason, name)
      }
    }))
    for (const result of results) {
      if (!result) continue
      this.candidates[result.package.name] = result
    }
  }

  private async loadDirectory(baseDir: string) {
    const path = baseDir + '/node_modules'
    const dirents = await readdir(path, { withFileTypes: true }).catch<Dirent[]>(() => [])
    const results = await Promise.all(dirents.map(async (outer) => {
      if (!outer.isDirectory() && !outer.isSymbolicLink()) return
      if (outer.name.startsWith('@')) {
        const dirents = await readdir(path + '/' + outer.name, { withFileTypes: true })
        return Promise.all(dirents.map(async (inner) => {
          const name = outer.name + '/' + inner.name
          const isLink = inner.isSymbolicLink()
          const isDep = !!this.metaDeps[name]
          if (isLink || isDep) return name
        }))
      } else {
        const isLink = outer.isSymbolicLink()
        const isDep = !!this.metaDeps[outer.name]
        if (isLink || isDep) return outer.name
      }
    }))
    return results.flat(1).filter((x): x is string => !!x)
  }

  private async loadMeta(filename: string) {
    const meta: PackageJson = JSON.parse(await readFile(filename, 'utf8'))
    meta.peerDependencies ||= {}
    meta.peerDependenciesMeta ||= {}
    return meta
  }

  private loadEcosystem(eco: Ecosystem) {
    for (const [name, { path, package: meta, workspace }] of Object.entries(this.candidates)) {
      const shortname = Ecosystem.check(eco, meta)
      if (!shortname) continue
      // TODO: check for conflicts
      // delete this.candidates[name]
      const manifest = Manifest.conclude(meta, eco.property)
      const exports = manifest.exports ?? {}
      if (exports['.'] !== null) {
        this.pkgTasks[name] ||= this.loadPackage(name, path, {
          shortname,
          workspace,
          manifest,
          package: pick(meta, LocalKey),
        })
      }
      for (const [path, manifest] of Object.entries(exports)) {
        if (!manifest) continue
        const fullname = join(name, path)
        this.pkgTasks[fullname] ||= this.loadPackage(fullname, path, {
          shortname: join(shortname, path),
          workspace,
          manifest,
          package: {
            name: fullname,
            version: meta.version,
          },
        })
      }
      if (!manifest.ecosystem) continue
      this.ecosystems.push(Ecosystem.resolve(name, manifest))
    }
  }

  private async loadPackage(name: string, cwd: string, object: LocalObject) {
    try {
      this.cache[name] = object
      const files = await glob(['README?(.*).md'], { cwd, caseSensitiveMatch: false })
      const readme = {}
      const readmeFiles = {}
      for (const file of files) {
        const locale = file.slice(7, -3)
        readme[locale] = null
        readmeFiles[locale] = join(cwd, file)
      }
      object.readme = readme
      defineProperty(object, '_readmeFiles', readmeFiles)
      await this.onSuccess?.(object)
      return object
    } catch (error) {
      this.onFailure?.(error, name)
    }
  }
}
