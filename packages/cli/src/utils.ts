import { resolve } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'

export const tempDir = resolve(__dirname, '../../../temp')

export class SecurityError extends Error {}

export async function checkSecurity(name: string) {
  await traverse(resolve(tempDir, name))

  async function traverse(cwd: string) {
    const dirents = await readdir(cwd, { withFileTypes: true })
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        await traverse(resolve(cwd, dirent.name))
      } else if (dirent.name.endsWith('.node')) {
        throw new SecurityError('native modules not allowed')
      }
    }
  }
}

export async function diskUsage(...names: string[]) {
  return traverse(resolve(tempDir, ...names))

  async function traverse(cwd: string) {
    const stats = await lstat(cwd)
    let total = stats.size
    if (!stats.isDirectory()) return total
    const names = await readdir(cwd)
    for (const name of names) {
      total += await traverse(resolve(cwd, name))
    }
    return total
  }
}
