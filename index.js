const yaml = require('js-yaml')
const mergeArrayByName = require('./lib/mergeArrayByName')

/**
 * @param {import('probot').Probot} robot
 */
module.exports = (robot, _, Settings = require('./lib/settings')) => {
  async function listRepos (context, { login, type }) {
    if (type.toLowerCase() === 'organization') {
      return context.octokit.paginate(
        context.octokit.repos.listForOrg.endpoint.merge({
          org: login
        })
      )
    } else {
      return context.octokit.paginate(
        context.octokit.repos.listForUser.endpoint.merge({
          username: login
        })
      )
    }
  }

  async function loadYaml (context, params) {
    try {
      const response = await context.octokit.repos.getContent(params)

      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        return null
      }

      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return null
      }

      return yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}
    } catch (e) {
      if (e.status === 404) {
        return null
      }

      throw e
    }
  }

  async function thisConfig (context) {
    return context.config('settings.yml', {}, { arrayMerge: mergeArrayByName })
  }

  async function defaultConfig (context) {
    const { payload } = context
    const { repository } = payload
    const { name, owner } = repository

    if (name === Settings.DEFAULT_REPO_NAME) {
      return thisConfig(context)
    }

    return loadYaml(context, {
      owner,
      repo: Settings.DEFAULT_REPO_NAME,
      path: Settings.FILE_NAME
    })
  }

  async function syncSettings (context, repo = context.repo()) {
    const config = await defaultConfig(context)
    return Settings.sync(context.octokit, repo, config)
  }

  async function syncRepoSettings (context, { owner, repo }) {
    if (await loadYaml(context, {
      owner,
      repo,
      path: Settings.FILE_NAME
    }) !== null) {
      return
    }

    await syncSettings(context, { owner, repo })
  }

  async function syncAllSettings (context) {
    const { payload } = context
    const { login, type } = payload.repository.owner

    const repositories = await listRepos(context, { login, type })
    await Promise.all(
      repositories
        .filter(repo => !repo.archived)
        .map(async (repo) => syncRepoSettings(context, { owner: login, repo: repo.name }))
    )
  }

  robot.on('push', async context => {
    const { payload } = context
    const { repository } = payload
    const { name: repositoryName } = repository

    const defaultBranch = payload.ref === 'refs/heads/' + repository.default_branch
    if (!defaultBranch) {
      robot.log.debug('Not working on the default branch. Returning.')
      return
    }

    const settingsModified = payload.commits.find(commit => {
      return commit.added.includes(Settings.FILE_NAME) ||
        commit.modified.includes(Settings.FILE_NAME)
    })

    if (!settingsModified) {
      robot.log.debug(`No changes in '${Settings.FILE_NAME}' detected. Returning.`)
      return
    }

    if (repositoryName === Settings.DEFAULT_REPO_NAME) {
      await syncAllSettings(context)
    }
  })

  robot.on('repository.edited', async context => {
    const { payload } = context
    const { changes, repository } = payload
    const { name, owner } = repository

    if (!Object.prototype.hasOwnProperty.call(changes, 'default_branch')) {
      robot.log.debug('Repository configuration was edited but the default branch was not affected. Returning.')
      return
    }

    if (name === Settings.DEFAULT_REPO_NAME || await loadYaml(context, {
      owner,
      repo,
      path: Settings.FILE_NAME
    }) === null) {
      robot.log.debug(`Default branch changed from '${changes.default_branch.from}' to '${repository.default_branch}'...`)

      await syncSettings(context)
    }
  })

  robot.on('repository.created', async context => {
    const { payload } = context
    const { repository } = payload
    const { name, owner } = repository

    if (name === Settings.DEFAULT_REPO_NAME || await loadYaml(context, {
      owner,
      repo,
      path: Settings.FILE_NAME
    }) === null) {
      await syncSettings(context)
    }
  })
}
