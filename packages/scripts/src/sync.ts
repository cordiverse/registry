import { DatedPackage, PackageJson, Registry, RemoteScanner, SearchObject, SearchResult } from '@cordisjs/registry'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { defineProperty, Dict, pick, Time } from 'cosmokit'
import { maxSatisfying } from 'semver'
import { resolve } from 'node:path'
import { dependencies } from '@cordiverse/registry-shared'
import { bundle, prepare, registry } from './bundle'
import { checkSecurity, diskUsage, SecurityError } from './utils'
import kleur from 'kleur'
import axios from 'axios'
import pMap from 'p-map'

declare module '@cordisjs/registry' {
  export interface SearchResult {
    shared?: DatedPackage[]
    ecosystems?: Ecosystem[]
  }

  export interface DatedPackage {
    object?: SearchObject
  }

  export interface SearchObject {
    versions?: RemotePackage[]
  }
}

const version = 6

async function getLegacy(dirname: string) {
  await mkdir(dirname + '/modules', { recursive: true })
  try {
    return JSON.parse(await readFile(dirname + '/cache', 'utf8')) as SearchResult
  } catch {
    return { total: 0, objects: [], shared: [], ecosystems: [], time: new Date(0).toISOString() }
  }
}

function hasExportsEntry(exports: PackageJson.Exports) {
  if (typeof exports !== 'object' || !exports) return false
  if ('browser' in exports) return true
  return Object.entries(exports).some(([key, value]) => !key.startsWith('.') && hasExportsEntry(value))
}

function hasEntry(meta: Partial<PackageJson>) {
  if (!meta.exports) return false
  return hasExportsEntry(meta.exports) || hasExportsEntry(meta.exports['.'])
}

const REFRESH_INTERVAL = Time.day / 2

function makeDict(result: SearchResult) {
  const dict: Dict<DatedPackage> = Object.create(null)
  for (const object of result.objects) {
    dict[object.package.name] = object.package
    defineProperty(object.package, 'object', object)
  }
  for (const object of result.shared || []) {
    dict[object.name] = object
  }
  return dict
}

interface NuxtPackage {
  version: string
  license: string
  publishedAt: string
  createdAt: string
  updatedAt: string
  downloads: {
    lastMonth: number
  }
}

async function getDownloads(name: string) {
  const { data } = await axios.get<NuxtPackage>('https://api.nuxtjs.org/api/npm/package/' + name)
  return data.downloads
}

function softmax(x: number) {
  const t = Math.exp(-x)
  return (1 - t) / (1 + t)
}

function minmax(x: number, min: number, max: number) {
  return Math.max(min, Math.min(max, x))
}

type Subjects = 'maintenance' | 'popularity' | 'quality'

const weights: Record<Subjects, number> = {
  maintenance: 0.3,
  popularity: 0.5,
  quality: 0.2,
}

const evaluators: Record<Subjects, (object: SearchObject) => Promise<number>> = {
  async maintenance(object) {
    if (object.verified) return 1
    if (object.insecure) return 0
    let score = 0.4
    if (object.manifest.preview) score -= 0.4
    if (object.portable) score += 0.2
    if (object.package.links.repository) score += 0.2
    return score
  },
  async popularity(object) {
    try {
      object.downloads = await getDownloads(object.package.name)
    } catch {}
    const actual = object.downloads?.lastMonth ?? 0
    const lifespan = minmax((Date.now() - +new Date(object.createdAt)) / Time.day, 7, 30)
    const estimated = 120 * (30 - lifespan) / 23 + actual / lifespan * 30 * (lifespan - 7) / 23
    return softmax(estimated / 120)
  },
  async quality(object) {
    try {
      return Math.exp(-Math.max(object.installSize, 100 * (1 << 10)) / (10 * (1 << 20)))
    } catch {
      return 0
    }
  },
}

let counter = 0
async function step<T>(title: string, callback: () => T | Promise<T>) {
  const startTime = Date.now()
  console.log(`┌ Step ${++counter}: ${title}`)
  const result = await callback()
  console.log(`└ Completed in ${Time.format(Date.now() - startTime)}`)
  return result
}

const log = (text: string) => console.log('│ ' + text)

async function catchError<T>(message: string, callback: () => T | Promise<T>) {
  try {
    return await callback()
  } catch (error) {
    console.log(error)
    return message
  }
}

const outdir = resolve(__dirname, '../../../dist')

class Analytics {
  public creates: Dict<number> = {}
  public updates: Dict<number> = {}
}

class Synchronizer {
  private analytics = new Analytics()
  private forceUpdate: boolean
  private latest: Dict<DatedPackage>
  private legacy: Dict<DatedPackage>
  private insecure: string[] = []
  private scanner = new RemoteScanner({
    registry,
  })

  async start() {
    const shouldUpdate = await step('check update', () => this.checkAll())
    if (!shouldUpdate) return

    await writeFile(process.env.GITHUB_OUTPUT, 'update=true')
    await step('analyze packages', () => this.analyze())
    await step('bundle packages', () => this.bundleAll())
    await step('generate output', () => this.generate())
  }

  checkUpdate(name: string) {
    const date1 = this.legacy[name]?.date
    const date2 = this.latest[name]?.date
    if (date1 === date2) return false
    if (!date1) {
      log(kleur.green(`- ${name}: added`))
    } else if (!date2) {
      log(kleur.red(`- ${name}: removed`))
    } else {
      log(kleur.yellow(`- ${name}: updated`))
    }
    return true
  }

  async checkAll() {
    const legacy = await getLegacy(outdir)

    await this.scanner.collect()
    this.scanner.shared = (await pMap(Object.keys(dependencies), async (name) => {
      const registry = await this.scanner.request<Registry>(`/${name}`)
      const version = maxSatisfying(Object.keys(registry.versions), dependencies[name])
      if (!version) return
      return {
        ...pick(registry, ['name', 'description']),
        version,
        date: registry.time[version],
        versions: {},
      }
    }, { concurrency: 5 })).filter(Boolean)

    const now = Date.now()
    this.latest = makeDict(this.scanner)
    this.legacy = makeDict(legacy)
    if (version !== legacy.version) {
      log('force update due to version mismatch')
      this.scanner.forceTime = now
      return this.forceUpdate = true
    }

    if (now - (legacy.forceTime ?? 0) > REFRESH_INTERVAL) {
      log('force update due to cache expiration')
      this.scanner.forceTime = now
      return this.forceUpdate = true
    }

    let shouldUpdate = false
    for (const name in { ...this.latest, ...this.legacy }) {
      const hasDiff = this.checkUpdate(name)
      shouldUpdate ||= hasDiff
    }
    if (!shouldUpdate) {
      log('all packages are up-to-date')
    }
    this.scanner.forceTime = legacy.forceTime
    return shouldUpdate
  }

  async analyze() {
    // check versions
    const shortnames = new Set<string>()
    await this.scanner.analyze({
      version: '4',
      before: (object) => {
        defineProperty(object.package, 'object', object)
      },
      onRegistry: async (registry, versions) => {
        if (!versions.length) return
        let min = '9999-99-99'
        for (const item of versions) {
          const day = registry.time[item.version].slice(0, 10)
          this.analytics.updates[day] = (this.analytics.updates[day] || 0) + 1
          if (day < min) min = day
        }
        this.analytics.creates[min] = (this.analytics.creates[min] || 0) + 1

        // sync npm mirror
        await fetch('https://registry-direct.npmmirror.com/' + registry.name + '/sync?sync_upstream=true', {
          method: 'PUT',
        }).catch((e) => {
          console.warn(`Sync error ${registry.name}:`, e)
        })
      },
      onSuccess: (object, versions) => {
        defineProperty(object, 'versions', versions)
        if (object.verified) shortnames.add(object.shortname)
      },
      onFailure: (name, reason) => {
        console.error(`Failed to analyze ${name}:`, reason)
      },
    })

    // resolve name conflicts
    for (const object of this.scanner.objects) {
      if (object.verified || !shortnames.has(object.shortname)) continue
      object.ignored = true
    }
  }

  shouldBundle(name: string) {
    if (this.forceUpdate) return true
    if (this.legacy[name]?.date !== this.latest[name]?.date) return true
  }

  async bundle(name: string, version: string, verified: boolean, item?: SearchObject, message = '') {
    try {
      await prepare(name, version)
    } catch {
      log(kleur.red(`${name}@${version}: prepare failed`))
      return { portable: false, insecure: true }
    }

    if (item) {
      try {
        item.installSize = await diskUsage(name, 'node_modules')
        item.publishSize = await diskUsage(name, 'node_modules', name)
      } catch (e) {
        console.log(e)
        log(kleur.red(`${name}@${version}: disk usage failed`))
        return { portable: false, insecure: true }
      }
    }

    try {
      await checkSecurity(name)
    } catch (e) {
      if (!(e instanceof SecurityError)) {
        console.log(e)
        log(kleur.red(`${name}@${version}: security check failed`))
      } else {
        this.insecure.push(`${name}@${version}: ${e.message}`)
        log(kleur.red(`${name}@${version}: ${e.message}`))
      }
      return { portable: false, insecure: true }
    }

    const meta = this.latest[name].object?.versions.find(v => v.version === version)
    if (!message && meta) {
      if (meta.cordis?.browser === false) {
        message = 'explicitly disabled'
      } else if (meta.cordis?.browser !== true && !meta.cordis?.public && !hasEntry(meta)) {
        message = 'no browser entry'
      }
    }
    message = message || await catchError('bundle failed', () => bundle(name, verified))
    if (message) {
      log(kleur.red(`${name}@${version}: ${message}`))
    } else {
      log(kleur.green(`${name}@${version}: success`))
    }
    return { portable: !message, insecure: false }
  }

  async bundleAll() {
    for (const name in dependencies) {
      if (!this.shouldBundle(name)) continue
      await this.bundle(name, dependencies[name], true)
    }

    await pMap(this.scanner.objects, async (item) => {
      if (item.ignored) return
      const legacy = this.legacy[item.package.name]
      if (!this.shouldBundle(item.package.name)) {
        Object.assign(item, pick(legacy.object, [
          'rating',
          'portable',
          'insecure',
          'downloads',
          'installSize',
          'publishSize',
          'score',
        ]))
      } else {
        const tasks = {} as Record<Subjects, Promise<number>>
        tasks.popularity = evaluators.popularity(item)
        const bundleTask = this
          .bundle(item.package.name, item.package.version, item.verified, item)
          .catch(() => ({ portable: false, insecure: true }))
          .then((result) => {
            item.portable = result.portable
            item.insecure ??= result.insecure
          })
        tasks.quality = bundleTask.then(() => evaluators.quality(item))
        tasks.maintenance = bundleTask.then(() => evaluators.maintenance(item))

        // evaluate score
        item.score.final = 0
        await Promise.all(Object.keys(weights).map(async (subject) => {
          let value = 0
          try {
            value = await tasks[subject]
          } catch (e) {
            console.log('│ Failed to evaluate %s of %s', subject, item.package.name)
          }
          item.score.detail[subject] = value
          item.score.final += weights[subject] * value
        }))
        item.rating = (item.score.final - 0.3) * 10
      }

      delete item.manifest.browser
      delete item.manifest.category
      delete item.manifest.insecure
      delete item.package.author
      delete item.score.detail
      delete item.searchScore
    }, { concurrency: 10 })
  }

  async generate() {
    this.scanner.version = version
    await writeFile(resolve(outdir, 'cache.json'), JSON.stringify(this.scanner))

    this.scanner.objects = this.scanner.objects.filter(item => !item.ignored)
    await writeFile(resolve(outdir, 'index.json'), JSON.stringify(this.scanner))

    this.scanner.objects = this.scanner.objects.filter(item => item.portable && !item.insecure && !item.manifest.hidden)
    for (const object of this.scanner.objects) {
      Object.assign(object.package, pick(object.versions[0], ['peerDependencies', 'peerDependenciesMeta']))
    }
    delete this.scanner.shared
    await writeFile(resolve(outdir, 'portable.json'), JSON.stringify(this.scanner))

    this.insecure.sort()
    await writeFile(resolve(outdir, 'insecure.txt'), this.insecure.join('\n'))
    await writeFile(resolve(outdir, 'analytics.json'), JSON.stringify(this.analytics))

    // remove unused packages
    const folders = await readdir(outdir + '/modules')
    for (let index = folders.length - 1; index >= 0; index--) {
      const folder = folders[index]
      if (folder.startsWith('@')) {
        const subfolders = await readdir(outdir + '/modules/' + folder)
        folders.splice(index, 1, ...subfolders.map(name => folder + '/' + name))
      }
    }
    for (const folder of folders) {
      if (folder in dependencies) continue
      if (this.scanner.objects.find(item => item.package.name === folder && item.portable)) continue
      await rm(outdir + '/modules/' + folder, { recursive: true, force: true })
    }
  }
}

if (require.main === module) {
  new Synchronizer().start()
}
