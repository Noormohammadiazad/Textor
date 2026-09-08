import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findWorkflow,
  nextWorkflowFile,
  readWorkflowName,
  releaseStamp,
  ROTATED_FILE,
  rotateWorkflow,
  WORKFLOW_DIR,
  workflowSlug,
} from '../scripts/rotateWorkflow.mjs'

/**
 * Every push moves the workflow to a path GitHub has never seen, which is the
 * only thing that restarts its run numbers. What matters is that the path is
 * new every time, that nothing is left behind, and that there is only ever one.
 */

const at = (iso: string) => new Date(iso)

describe('naming the workflow', () => {
  it('stamps the moment in UTC, to the second', () => {
    expect(releaseStamp(at('2026-09-23T03:04:05.678Z'))).toBe('20260923-030405')
  })

  it('reads the display name, and only the top-level one', () => {
    expect(readWorkflowName('name: Deploy\non:\n  push:\n')).toBe('Deploy')
    expect(readWorkflowName("name: 'Build & publish'\n")).toBe('Build & publish')
    expect(readWorkflowName('on: push\njobs:\n  verify:\n    name: Typecheck\n')).toBe('')
  })

  it('makes the name safe for a file, whatever it is', () => {
    expect(workflowSlug('Deploy')).toBe('deploy')
    expect(workflowSlug('  Build & Publish! ')).toBe('build-publish')
    expect(workflowSlug('')).toBe('workflow')
    expect(workflowSlug('انتشار')).toBe('workflow')
  })

  it('names the next file after the workflow and the moment', () => {
    const next = nextWorkflowFile({
      current: 'pipeline.yml',
      name: 'Deploy',
      now: at('2026-09-23T03:04:05Z'),
    })
    expect(next).toBe('deploy-20260923-030405.yml')
    expect(next).toMatch(ROTATED_FILE)
  })

  it('never goes back to a name that could have been used', () => {
    // Two pushes in the same second, and a clock that has gone backwards.
    expect(
      nextWorkflowFile({
        current: 'deploy-20260923-030405.yml',
        name: 'Deploy',
        now: at('2026-09-23T03:04:05Z'),
      }),
    ).toBe('deploy-20260923-030406.yml')
    expect(
      nextWorkflowFile({
        current: 'deploy-20260923-030405.yml',
        name: 'Deploy',
        now: at('2026-09-01T00:00:00Z'),
      }),
    ).toBe('deploy-20260923-030406.yml')
    expect(
      nextWorkflowFile({
        current: 'deploy-20261231-235959.yml',
        name: 'Deploy',
        now: at('2026-12-31T23:59:59Z'),
      }),
    ).toBe('deploy-20270101-000000.yml')
  })
})

describe('rotating the file', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function repoWith(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'textor-rotate-'))
    roots.push(root)
    mkdirSync(join(root, WORKFLOW_DIR), { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, WORKFLOW_DIR, name), body)
    return root
  }

  const listed = (root: string) => readdirSync(join(root, WORKFLOW_DIR)).sort()

  it('moves the one workflow and leaves nothing behind', () => {
    const body = 'name: Deploy\non:\n  push:\n    branches: [main]\n'
    const root = repoWith({ 'pipeline.yml': body })
    const first = rotateWorkflow({ root, now: at('2026-09-23T03:04:05Z') })
    expect(first).toEqual({ from: 'pipeline.yml', to: 'deploy-20260923-030405.yml' })
    expect(listed(root)).toEqual(['deploy-20260923-030405.yml'])
    expect(readFileSync(join(root, WORKFLOW_DIR, first.to), 'utf8')).toBe(body)

    const second = rotateWorkflow({ root, now: at('2026-09-24T10:00:00Z') })
    expect(second).toEqual({ from: 'deploy-20260923-030405.yml', to: 'deploy-20260924-100000.yml' })
    expect(listed(root)).toEqual(['deploy-20260924-100000.yml'])
  })

  it('follows the display name when it changes', () => {
    const root = repoWith({ 'deploy-20260923-030405.yml': 'name: Release\n' })
    expect(rotateWorkflow({ root, now: at('2026-10-01T00:00:00Z') }).to).toBe('release-20261001-000000.yml')
  })

  it('refuses when there is no workflow, or more than one', () => {
    expect(() => findWorkflow(repoWith({}))).toThrow(/exactly one workflow.*found 0/)
    const two = repoWith({ 'ci.yml': 'name: CI\n', 'deploy.yaml': 'name: Deploy\n' })
    expect(() => rotateWorkflow({ root: two })).toThrow(/found 2: ci\.yml, deploy\.yaml/)
    expect(listed(two)).toEqual(['ci.yml', 'deploy.yaml'])
  })

  it('counts only workflow files', () => {
    const root = repoWith({ 'deploy-20260923-030405.yml': 'name: Deploy\n', 'README.md': '# notes\n' })
    expect(findWorkflow(root)).toBe('deploy-20260923-030405.yml')
  })
})

describe('this repository', () => {
  it('holds one workflow, under a name the rotation gave it', () => {
    // A second file would double every entry in the Actions tab; a name that
    // did not come from the rotation is one GitHub may already have counted.
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(findWorkflow(root)).toMatch(ROTATED_FILE)
  })
})
