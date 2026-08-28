'use strict'

const { execSync } = require('child_process')
const path = require('path')

/**
 * 基于 gh CLI 的发布操作封装（发布脚本运行环境必须已安装并认证 gh）
 * 统一通过系统 gh 命令完成，避免引入 axios 等运行时依赖。
 */

const GITHUB_API = 'https://api.github.com'

/**
 * 执行 gh 命令并返回 stdout；失败抛错并附带 stderr
 * @param {string[]} args gh 参数
 * @param {string} repo 完整仓库名（owner/repo）
 * @returns {string}
 */
function gh(args, repo) {
  const full = [...args]
  // gh api 的 endpoint 已含 owner/repo，不接受 --repo；其余子命令需要 --repo
  if (repo && args[0] !== 'api') full.push('--repo', repo)
  try {
    return execSync(`gh ${full.map(capArg).join(' ')}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString().trim() : e.message
    throw new Error(`gh ${full.join(' ')} 失败：${detail}`)
  }
}

/**
 * 对含空格/特殊字符的参数做基础转义（gh CLI 参数均为构建脚本可控值）
 * @param {string} arg
 * @returns {string}
 */
function capArg(arg) {
  const s = String(arg)
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/**
 * 确保容器 tag 存在（幂等创建 release）
 * @param {string} repo 完整仓库名
 * @param {string} tag 容器 tag
 */
function ensureTag(repo, tag) {
  try {
    gh(['release', 'view', tag, '--json', 'tagName', '--jq', '.tagName'], repo)
    return
  } catch (e) {
    const notes = 'firefly-resources 容器发布位（恒定 tag，不承载版本语义）'
    gh(['release', 'create', tag, '--title', tag, '--notes', notes, '--latest=false'], repo)
  }
}

/**
 * 列出容器 tag 下全部资产名
 * @param {string} repo 完整仓库名
 * @param {string} tag 容器 tag
 * @returns {string[]}
 */
function listAssetNames(repo, tag) {
  try {
    const out = gh(['release', 'view', tag, '--json', 'assets', '--jq', '[.assets[].name]'], repo)
    if (!out) return []
    return JSON.parse(out)
  } catch (e) {
    return []
  }
}

let releaseIdCache = null

/**
 * 获取容器 tag 对应 release 的 id（内部缓存）
 * @param {string} repo 完整仓库名
 * @param {string} tag 容器 tag
 * @returns {string}
 */
function getReleaseId(repo, tag) {
  if (releaseIdCache) return releaseIdCache
  const out = gh(['api', `repos/${repo}/releases/tags/${tag}`, '--jq', '.id'], repo)
  releaseIdCache = out.trim()
  return releaseIdCache
}

/**
 * 按资产名查询 asset id
 * @param {string} repo 完整仓库名
 * @param {string} tag 容器 tag
 * @param {string} name 资产名
 * @returns {string} asset id
 */
function getAssetId(repo, tag, name) {
  const escaped = name.replace(/"/g, '\\"')
  const out = gh(
    ['api', `repos/${repo}/releases/tags/${tag}`, '--jq', `.assets[] | select(.name==\"${escaped}\") | .id`],
    repo
  )
  const id = out.trim()
  if (!id) throw new Error(`[gh] 找不到资产 ${name}（tag ${tag}）`)
  return id
}

/**
 * 上传资产到容器 tag 并（如需）重命名为目标资产名
 * 说明：GitHub 资产上传端点在 uploads.github.com，gh api 在部分环境中会对
 * POST /releases/{id}/assets 请求 api.github.com 得到 404；而 gh release upload 走
 * uploads 域名可靠。因此分两步：用本地文件名上传，再 PATCH assets/{id} 改名。
 * @param {object} opts
 * @param {string} opts.repo 完整仓库名
 * @param {string} opts.tag 容器 tag
 * @param {string} opts.localPath 本地文件路径
 * @param {string} opts.name 目标资产名
 */
function uploadAsset({ repo, tag, localPath, name }) {
  gh(['release', 'upload', tag, localPath], repo)
  const baseName = path.basename(localPath)
  if (baseName !== name) {
    const assetId = getAssetId(repo, tag, baseName)
    gh(['api', '--method', 'PATCH', '-f', `name=${name}`, '-f', 'label=resources', `repos/${repo}/releases/assets/${assetId}`], repo)
  }
}

/**
 * 从容器 tag 删除资产
 * @param {string} repo 完整仓库名
 * @param {string} tag 容器 tag
 * @param {string[]} names 资产名列表
 */
function deleteAssets(repo, tag, names) {
  for (const name of names) {
    try {
      gh(['release', 'delete-asset', tag, name, '--yes'], repo)
    } catch (e) {
      console.log(`[gh] 删除资产失败（跳过）：${name}`)
    }
  }
}

/**
 * 获取容器 tag 资产的标准下载 URL 前缀
 * @param {string} repo 完整仓库名
 * @param {string} tag 容器 tag
 * @returns {string}
 */
function assetDownloadBase(repo, tag) {
  return `${GITHUB_API}/repos/${repo}/releases/download/${tag}`
}

module.exports = {
  GITHUB_API,
  ensureTag,
  listAssetNames,
  uploadAsset,
  deleteAssets,
  assetDownloadBase
}