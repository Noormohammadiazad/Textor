/**
 * Move the workflow to a file name it has never had — once per push, so every
 * push shows up in the Actions tab as run #1.
 *
 * GitHub numbers a workflow's runs by the path of its file, not by its `name:`.
 * Changing the display name keeps counting (Pipeline #6 was followed by
 * Deploy #7), and so does going back to a path used before, because that
 * path's history is still on record: alternating between two names would
 * count #1, #1, #2, #2. Only a path that has never existed starts at #1.
 *
 * So the one workflow file moves to `<name>-<UTC date>-<UTC time>.yml`, named
 * after its own `name:` and always later than the name it had, and the
 * directory never holds more than that one file. It refuses to run if it finds
 * none or several: that would be an orphan left behind, or a second workflow
 * doubling every entry in the Actions tab.
 *
 * Run: node scripts/rotateWorkflow.mjs   (CLAUDE.md runs it on every push)
 */

import { readdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WORKFLOW_DIR = '.github/workflows'

/** `deploy-20260923-030405.yml`: a slug, then the moment it was named, in UTC. */
export const ROTATED_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{8}-\d{6})\.yml$/

const isWorkflowFile = (file) => /\.ya?ml$/.test(file)

/** The workflow's display name: its top-level `name:`, unquoted. */
export function readWorkflowName(source) {
  const match = /^name:[ \t]*(.*?)[ \t]*$/m.exec(source)
  if (!match) return ''
  return match[1].replace(/^(['"])(.*)\1$/, '$2').trim()
}

/** A file-name-safe form of the display name. */
export function workflowSlug(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'workflow'
}

/** `YYYYMMDD-HHMMSS`, in UTC, so the same moment names the same file on any machine. */
export function releaseStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  )
}

function parseStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s))
}

/**
 * The name the workflow moves to.
 *
 * Always later than the current one, even when the clock says otherwise — two
 * pushes in the same second, or a clock that went back — because a name that
 * sorts earlier could be one already used.
 */
export function nextWorkflowFile({ current, name, now }) {
  let at = new Date(Math.floor(now.getTime() / 1000) * 1000)
  const previous = ROTATED_FILE.exec(current)
  const previousAt = previous ? parseStamp(previous[2]) : null
  if (previousAt && previousAt.getTime() >= at.getTime()) at = new Date(previousAt.getTime() + 1000)
  return `${workflowSlug(name)}-${releaseStamp(at)}.yml`
}

/** The one workflow file under `root`, or an error naming what was found instead. */
export function findWorkflow(root) {
  const dir = join(root, WORKFLOW_DIR)
  const files = readdirSync(dir).filter(isWorkflowFile).sort()
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one workflow in ${WORKFLOW_DIR}, found ${files.length}` +
        (files.length ? `: ${files.join(', ')}` : ''),
    )
  }
  return files[0]
}

/** Rename the workflow file in place. Returns both names, for the log. */
export function rotateWorkflow({ root, now = new Date() }) {
  const dir = join(root, WORKFLOW_DIR)
  const from = findWorkflow(root)
  const name = readWorkflowName(readFileSync(join(dir, from), 'utf8'))
  const to = nextWorkflowFile({ current: from, name, now })
  renameSync(join(dir, from), join(dir, to))
  return { from, to }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const { from, to } = rotateWorkflow({ root })
    process.stdout.write(`workflow: ${WORKFLOW_DIR}/${from} -> ${WORKFLOW_DIR}/${to}\n`)
  } catch (err) {
    console.error(`rotate-workflow: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
