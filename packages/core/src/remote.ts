import { readFile } from 'node:fs/promises'
import { Awaitable, Dict, Time } from 'cosmokit'
import { Registry, RemotePackage, SearchObject, SearchResult } from './types.ts'
import { Ecosystem, Manifest } from './manifest.ts'
import { compare } from 'semver'
import PQueue from 'p-queue'

export interface RemoteScanner extends SearchResult {}

export namespace RemoteScanner {
  export interface Options {
    cacheDir?: string
    collect?: CollectOptions
    registry: string
    request?<T>(url: URL, config?: RequestConfig): Promise<T>
    onFailure?(object: SearchObject, reason: any): Awaitable<void>
    onSuccess?(object: SearchObject, versions?: RemotePackage[]): Awaitable<void>
    onSkipped?(object: SearchObject): Awaitable<void>
  }

  interface CollectOptions {
    step?: number
    margin?: number
    timeout?: number
  }
}

export interface RequestConfig {
  timeout?: number
}

const version = 1

interface SearchCache {
  version: number
  registry: string
  packages: Dict<string>
}

export class RemoteScanner {
  private ecoTasks: Promise<void>[] = []
  private requestQueue = new PQueue({ concurrency: 10 })
  private searchCache: SearchCache = Object.create(null)
  private legacyResult: SearchResult = {
    total: 0,
    objects: [],
    time: new Date().toISOString(),
  }

  constructor(public options: RemoteScanner.Options) {}

  async request<T>(path: string, config?: RequestConfig) {
    const url = new URL(path, this.options.registry)
    if (this.options.request) {
      return this.options.request<T>(url, config)
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(config?.timeout ?? 30000),
    })
    return await response.json() as T
  }

  private async _search(eco: Ecosystem, cache: Dict<SearchObject>, offset: number) {
    const { step = 250, timeout = Time.second * 30 } = this.options.collect ?? {}
    const { keywords } = eco
    const result = await this.request<SearchResult>(`/-/v1/search?text=${keywords.join('+')}&size=${step}&from=${offset}`, { timeout })
    for (const object of result.objects) {
      cache[object.package.name] = object
    }
    return result.total
  }

  public async search(eco: Ecosystem) {
    const { step = 250, margin = 25 } = this.options.collect ?? {}
    const cache: Dict<SearchObject> = Object.create(null)
    const total = await this._search(eco, cache, 0)
    for (let offset = Object.values(cache).length; offset < total; offset += step - margin) {
      await this._search(eco, cache, offset - margin)
    }
    return Object.values(cache)
  }

  async loadEcosystem(eco: Ecosystem) {
    const objects = await this.search(eco)
    await Promise.all(objects.map(async (object) => {
      try {
        const { name, date } = object.package
        if (date === this.searchCache.packages[name]) {
          const legacy = this.legacyResult.objects.find(object => object.package.name === name)
          if (legacy) {
            await this.options.onSuccess?.(legacy)
          } else {
            await this.options.onSkipped?.(object)
          }
        } else {
          const versions = await this.loadPackage(eco, object)
          if (versions) {
            await this.options.onSuccess?.(object, versions)
          } else {
            await this.options.onSkipped?.(object)
          }
        }
      } catch (error) {
        await this.options.onFailure?.(object, error)
      }
    }))
  }

  async _initCache() {
    if (!this.options.cacheDir) return
    try {
      const cache: SearchCache = JSON.parse(await readFile(this.options.cacheDir + '/cache.json', 'utf8'))
      const legacy: SearchResult = JSON.parse(await readFile(this.options.cacheDir + '/index.json', 'utf8'))
      if (cache.version !== version || cache.registry !== this.options.registry) return
      Object.setPrototypeOf(cache.packages, null)
      this.searchCache = cache
      this.legacyResult = legacy
    } catch {}
  }

  public async collect() {
    await this._initCache()
    this.time = new Date().toUTCString()
    this.ecoTasks.push(this.loadEcosystem(Ecosystem.INIT))
    while (this.ecoTasks.length) {
      await Promise.all(this.ecoTasks.splice(0))
    }
  }

  public async loadPackage(eco: Ecosystem, object: SearchObject) {
    const registry = await this.requestQueue.add(() => {
      return this.request<Registry>(`/${name}`)
    }, { throwOnTimeout: true })
    const versions = Object.values(registry.versions).sort((a, b) => compare(b.version, a.version))

    const latestVersion = registry['dist-tags']['latest']
    if (!latestVersion) return
    const latest = registry.versions[latestVersion]
    if (!latest || latest.deprecated) return

    const shortname = Ecosystem.check(eco, latest)
    if (!shortname) return

    object.shortname = shortname
    object.package.contributors ??= latest.author ? [latest.author] : []
    object.package.keywords = latest.keywords ?? []

    const manifest = Manifest.conclude(latest, eco.property)
    object.manifest = manifest
    object.insecure = manifest.insecure
    object.category = manifest.category

    if (manifest.ecosystem) {
      this.ecoTasks.push(this.loadEcosystem(Ecosystem.resolve(registry.name, manifest)))
    }

    const times = versions.map(item => registry.time[item.version]).sort()
    object.createdAt = times[0]
    object.updatedAt = times[times.length - 1]

    return versions
  }
}
