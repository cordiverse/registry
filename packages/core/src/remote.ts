import { Awaitable, Dict, Time } from 'cosmokit'
import { Registry, RemotePackage, SearchObject, SearchResult } from './types.ts'
import { Ecosystem, Manifest } from './manifest.ts'
import { compare } from 'semver'
import PQueue from 'p-queue'

export interface RemoteScanner extends SearchResult {}

export namespace RemoteScanner {
  export interface Options {
    registry: string
    request?<T>(url: URL, config?: RequestConfig): Promise<T>
    onFailure?(object: SearchObject, reason: any): Awaitable<void>
    onSuccess?(object: SearchObject, versions: RemotePackage[]): Awaitable<void>
    onSkipped?(object: SearchObject): Awaitable<void>
  }

  export interface CollectOptions {
    step?: number
    margin?: number
    timeout?: number
  }
}

export interface RequestConfig {
  timeout?: number
}

// function clear(object: Dict) {
//   for (const key of Object.keys(object)) {
//     delete object[key]
//   }
// }

export class RemoteScanner {
  tasks: Promise<void>[] = []
  cache: Dict<Dict<SearchObject>> = Object.create(null)
  private queue = new PQueue({ concurrency: 10 })

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

  private async _search(eco: Ecosystem, cache: Dict<SearchObject>, offset: number, config: RemoteScanner.CollectOptions = {}) {
    const { step = 250, timeout = Time.second * 30 } = config
    const { keywords } = eco
    const result = await this.request<SearchResult>(`/-/v1/search?text=${keywords.join('+')}&size=${step}&from=${offset}`, { timeout })
    this.version = result.version
    for (const object of result.objects) {
      cache[object.package.name] = object
    }
    return result.total
  }

  public async search(eco: Ecosystem, config: RemoteScanner.CollectOptions = {}) {
    const { step = 250, margin = 25 } = config
    const cache: Dict<SearchObject> = Object.create(null)
    const total = await this._search(eco, cache, 0, config)
    for (let offset = Object.values(cache).length; offset < total; offset += step - margin) {
      await this._search(eco, cache, offset - margin, config)
    }
    return Object.values(cache)
  }

  async loadEcosystem(eco: Ecosystem) {
    const objects = await this.search(eco)
    await Promise.all(objects.map(async (object) => {
      if (object.ignored) return
      try {
        const versions = await this.loadPackage(eco, object)
        if (versions) {
          await this.options.onSuccess?.(object, versions)
          return versions
        } else {
          object.ignored = true
          await this.options.onSkipped?.(object)
        }
      } catch (error) {
        object.ignored = true
        await this.options.onFailure?.(object, error)
      }
    }))
  }

  public async collect() {
    this.time = new Date().toUTCString()
    this.tasks.push(this.loadEcosystem(Ecosystem.INIT))
    while (this.tasks.length) {
      await Promise.all(this.tasks.splice(0))
    }
  }

  public async loadPackage(eco: Ecosystem, object: SearchObject) {
    const registry = await this.queue.add(() => this.request<Registry>(`/${object.package.name}`), { throwOnTimeout: true })
    const versions = Object.values(registry.versions).sort((a, b) => compare(b.version, a.version))

    const activeVersions = versions.filter(item => !item.deprecated)
    if (!activeVersions.length) return

    const latest = activeVersions[0]
    const shortname = Ecosystem.check(eco, latest)
    if (!shortname) return

    object.ecosystem = eco.name
    object.shortname = shortname
    object.package.contributors ??= latest.author ? [latest.author] : []
    object.package.keywords = latest.keywords ?? []

    const manifest = Manifest.conclude(latest, eco.property)
    object.manifest = manifest
    object.insecure = manifest.insecure
    object.category = manifest.category

    if (manifest.ecosystem) {
      this.tasks.push(this.loadEcosystem(Ecosystem.resolve(registry.name, manifest)))
    }

    const times = versions.map(item => registry.time[item.version]).sort()
    object.createdAt = times[0]
    object.updatedAt = times[times.length - 1]

    return versions
  }
}
