const test = require('node:test')
const assert = require('node:assert/strict')
const waitForPages = require('./wait-for-pages.cjs')

const sha = 'current-commit'
const branchRun = (status, extras = {}) => ({
  path: 'dynamic/pages/pages-build-deployment', head_sha: sha, status, ...extras,
})

function fixture({ mode = 'legacy', source = 'main', snapshots = [[branchRun('completed')]], commits = [sha] } = {}) {
  let clock = 0
  let checks = 0
  let polls = 0
  const messages = []
  const listRuns = () => {}
  const github = {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: commits[Math.min(checks++, commits.length - 1)] } } }),
        getPages: async () => ({ data: { build_type: mode, source: { branch: source } } }),
      },
      actions: { listWorkflowRunsForRepo: listRuns },
    },
    paginate: async (method, args) => {
      assert.equal(method, listRuns)
      assert.equal(args.head_sha, sha)
      assert.equal(args.branch, 'main')
      return snapshots[Math.min(polls++, snapshots.length - 1)]
    },
  }
  return {
    input: { github, context: { ref: 'refs/heads/main', sha, repo: { owner: 'owner', repo: 'repo' } }, core: { info: message => messages.push(message) } },
    options: { now: () => clock, pause: async ms => { clock += ms }, pollMs: 10, timeoutMs: 100 },
    polls: () => polls,
    messages,
  }
}

test('waits for creation, queueing and completion of the matching branch deployment', async () => {
  const f = fixture({ snapshots: [[], [branchRun('queued')], [branchRun('in_progress')], [branchRun('completed')]] })
  assert.equal(await waitForPages(f.input, f.options), true)
  assert.equal(f.polls(), 4)
})

test('Actions publishing does not wait for a Jekyll workflow', async () => {
  const f = fixture({ mode: 'workflow' })
  assert.equal(await waitForPages(f.input, f.options), true)
  assert.equal(f.polls(), 0)
})

test('does not confuse another commit or the custom workflow with the branch deployment', async () => {
  const f = fixture({ snapshots: [[branchRun('completed', { head_sha: 'old-commit' }), branchRun('completed', { path: '.github/workflows/deploy.yml' })]] })
  await assert.rejects(waitForPages(f.input, f.options), /Timed out/)
})

test('waits for a rerun even when an earlier matching run has completed', async () => {
  const f = fixture({ snapshots: [[branchRun('completed'), branchRun('in_progress')], [branchRun('completed'), branchRun('completed')]] })
  assert.equal(await waitForPages(f.input, f.options), true)
  assert.equal(f.polls(), 2)
})

test('can publish the valid Vite artifact after a failed or cancelled branch build finishes', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const f = fixture({ snapshots: [[branchRun('completed', { conclusion })]] })
    assert.equal(await waitForPages(f.input, f.options), true)
  }
})

test('skips old builds before waiting, during waiting, and immediately before publishing', async () => {
  for (const commits of [['newer'], [sha, 'newer'], [sha, sha, 'newer']]) {
    const f = fixture({ commits })
    assert.equal(await waitForPages(f.input, f.options), false)
  }
})

test('fails on timeout without publishing before an unfinished branch deployment', async () => {
  const f = fixture({ snapshots: [[branchRun('in_progress')]] })
  await assert.rejects(waitForPages(f.input, f.options), /Timed out/)
})

test('rejects unsupported publishing sources and non-main runs', async () => {
  for (const config of [{ mode: 'unexpected' }, { source: 'another-branch' }]) {
    const f = fixture(config)
    await assert.rejects(waitForPages(f.input, f.options), /Expected GitHub Actions publishing/)
  }
  const f = fixture()
  f.input.context.ref = 'refs/heads/feature'
  await assert.rejects(waitForPages(f.input, f.options), /must run from main/)
})

test('does not publish when the Pages API cannot be read', async () => {
  const f = fixture()
  f.input.github.rest.repos.getPages = async () => { throw new Error('API unavailable') }
  await assert.rejects(waitForPages(f.input, f.options), /API unavailable/)
})
