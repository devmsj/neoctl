import { spawnSync } from 'node:child_process'
import { access, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const webDir = fileURLToPath(new URL('../../web/', import.meta.url))
const vite = fileURLToPath(new URL('../../web/node_modules/vite/bin/vite.js', import.meta.url))
const config = fileURLToPath(new URL('../../web/vite.control.config.js', import.meta.url))
const output = new URL('../viewer-dist/', import.meta.url)

try {
  await access(vite)
  const built = spawnSync(process.execPath, [vite, 'build', '--config', config], {
    cwd: webDir,
    stdio: 'inherit',
    shell: false,
  })
  if (built.error) throw built.error
  if (built.status !== 0) throw new Error(`Viewer build failed (${built.signal || built.status})`)
  await rename(new URL('control-viewer.html', output), new URL('index.html', output))
  console.log(`Read-only Control viewer built: ${fileURLToPath(output)}`)
} catch (error) {
  console.error('Unable to build Control viewer. Install web dependencies first (npm --prefix web ci).')
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
