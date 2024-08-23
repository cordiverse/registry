import { createRequire } from 'node:module'
import { LocalScanner, RemoteScanner } from '@cordisjs/registry'
import { cac } from 'cac'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const cli = cac('cordis-registry').help().version(version)

cli.command('local', 'Scan local packages')
  .option('--cwd <name>', 'Current working directory')
  .action(async (options) => {
    const baseDir = resolve(process.cwd(), options.cwd ?? '.')
    const scanner = new LocalScanner(baseDir, {
      onSuccess: async ({ package: { name, version } }) => {
        console.log(`${name}@${version}`)
      },
    })
    await scanner.collect().catch(console.error)
  })

cli.command('remote', 'Scan remote packages')
  .option('--cache-dir <name>', 'Cache directory')
  .action(async (options) => {
    const scanner = new RemoteScanner({
      cacheDir: options.cacheDir ? resolve(process.cwd(), options.cacheDir) : undefined,
      onSuccess: async ({ package: { name, version } }) => {
        console.log(`${name}@${version}`)
      },
    })
    await scanner.collect().catch(console.error)
  })

cli.parse()

if (!cli.matchedCommand && !cli.options.help) {
  cli.outputHelp()
}
