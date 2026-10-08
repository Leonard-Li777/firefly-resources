'use strict'

/**
 * GitHub 认证 token 解析（零依赖，node 内置）
 *
 * firefly-resources 仓库已转为私有：raw 索引与 release 资产对匿名访问一律 404。
 * 消费方/发布方在此统一解析 token，进程内缓存。
 *
 * 优先级：GH_TOKEN（跨仓库专用，CI 注入）→ GITHUB_TOKEN → 本地 gh CLI 登录态。
 * 三者皆无时返回 null（公开仓库匿名可用；私有仓库将在拉取处报 404 并提示）。
 */

const { spawnSync } = require('child_process')

let cachedToken

/**
 * @returns {string|null}
 */
function resolveGithubToken() {
  if (cachedToken !== undefined) return cachedToken
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv) {
    cachedToken = fromEnv
    return cachedToken
  }
  try {
    const out = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    if (out.status === 0 && out.stdout && out.stdout.trim()) {
      cachedToken = out.stdout.trim()
      return cachedToken
    }
  } catch (_) {
    /* 未安装 gh / 未登录时忽略 */
  }
  cachedToken = null
  return null
}

/**
 * 认证请求头（仅应发往 GitHub 官方域名）
 * @param {object} [extra]
 * @returns {object}
 */
function authHeaders(extra = {}) {
  const token = resolveGithubToken()
  return token ? { authorization: `token ${token}`, ...extra } : { ...extra }
}

module.exports = { resolveGithubToken, authHeaders }
