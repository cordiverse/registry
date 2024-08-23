import { readFile } from 'node:fs/promises'
import { Ecosystem, RemoteScanner, SearchResult } from '@cordisjs/registry'
import { Dict } from 'cosmokit'

declare module '@cordisjs/registry' {
  export interface SearchResult {
    ecosystems?: Dict<Ecosystem>
  }
}

interface Analytics {
  creates: Dict<number>
  updates: Dict<number>
  authors: Dict<number>
}

export class Synchronizer extends RemoteScanner {
  analytics: Analytics = {
    creates: Object.create(null),
    updates: Object.create(null),
    authors: Object.create(null),
  }

  constructor() {
    super({
      registry: 'https://registry.npmjs.org',
      onRegistry: (object, registry) => {
        if (!registry.versions.length) return
        let min = '9999-99-99'
        for (const version in registry.versions) {
          const day = registry.time[version].slice(0, 10)
          this.analytics.updates[day] = (this.analytics.updates[day] || 0) + 1
          if (day < min) min = day
        }
        this.analytics.creates[min] = (this.analytics.creates[min] || 0) + 1

        // sync npm mirror
        fetch('https://registry-direct.npmmirror.com/' + registry.name + '/sync?sync_upstream=true', {
          method: 'PUT',
        }).catch((e) => {
          console.warn(`Sync error ${registry.name}:`, e)
        })
      },
      onFailure: (name, reason) => {
        console.error(`Failed to analyze ${name}:`, reason)
      },
    })
  }
}
