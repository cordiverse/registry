import { createRequire } from 'node:module'
import { LocalScanner, RemoteScanner } from '@cordisjs/registry'
import { cac } from 'cac'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const cli = cac('cordis-registry').help().version(version)

cli.command('local', 'Scan local packages')
  .action(async () => {
    const scanner = new LocalScanner(process.cwd(), {
      onSuccess: async ({ package: { name, version } }) => {
        console.log(`${name}@${version}`)
      },
    })
    await scanner.collect().catch(console.error)
  })

cli.command('remote', 'Scan remote packages')
  .action(async () => {
    const scanner = new RemoteScanner({
      registry: 'https://registry.npmmirror.com',
      onSuccess: async ({ package: { name, version }, ecosystem }) => {
        console.log(`[${ecosystem}] ${name}@${version}`)
      },
    })
    await scanner.collect().catch(console.error)
  })

cli.parse()

if (!cli.matchedCommand && !cli.options.help) {
  cli.outputHelp()
}
