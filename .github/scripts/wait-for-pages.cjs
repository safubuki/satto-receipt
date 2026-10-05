const { setTimeout: sleep } = require('node:timers/promises')

// Read the existing Pages configuration; never change it or write to a branch.
module.exports = async function waitForPages(
  { github, context, core },
  { pause = sleep, now = Date.now, timeoutMs = 15 * 60_000, pollMs = 15_000 } = {},
) {
  if (context.ref !== 'refs/heads/main') {
    throw new Error('Pages deployment must run from main.')
  }

  const repo = context.repo
  const isCurrent = async () => {
    const { data } = await github.rest.repos.getBranch({ ...repo, branch: 'main' })
    if (data.commit.sha === context.sha) return true
    core.info('A newer main commit exists. Skip publishing this older build.')
    return false
  }

  if (!await isCurrent()) return false

  const { data: pages } = await github.rest.repos.getPages(repo)
  core.info(`Existing Pages publishing mode: ${pages.build_type}`)
  if (pages.build_type === 'workflow') {
    core.info('Pages uses GitHub Actions. No branch-based deployment to wait for.')
    return await isCurrent()
  }
  if (pages.build_type !== 'legacy' || pages.source?.branch !== 'main') {
    throw new Error('Expected GitHub Actions publishing or branch-based publishing from main.')
  }

  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (!await isCurrent()) return false
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
      ...repo,
      branch: 'main',
      head_sha: context.sha,
      per_page: 100,
    })
    const branchRuns = runs.filter(run =>
      run.path === 'dynamic/pages/pages-build-deployment' && run.head_sha === context.sha,
    )
    if (branchRuns.length > 0 && branchRuns.every(run => run.status === 'completed')) {
      core.info(`Branch-based Pages deployment finished for ${context.sha}. Publish the Vite build next.`)
      return await isCurrent()
    }
    core.info(branchRuns.length === 0
      ? 'Waiting for GitHub to start the branch-based Pages deployment for this commit.'
      : 'Waiting for the branch-based Pages deployment to finish.')
    await pause(pollMs)
  }

  throw new Error('Timed out waiting for branch-based Pages deployment. The Vite artifact was not published early; re-run this deployment once the Pages run has finished.')
}
