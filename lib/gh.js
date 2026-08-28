'use strict'

const { execSync } = require('child_process')

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
  if (repo) full.push('--repo', repo)
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

/**
 * 上传资产到容器 tag
 * 幂等由调用方用 listAssetNames 预判决定；此处不带 --clobber，
 * 若出现同名资产 gh 会报错（资产名不可变保护）。
 * @param {object} opts
 * @param {string} opts.repo 完整仓库名
 * @param {string} opts.tag 容器 tag
 * @param {string} opts.localPath 本地文件路径
 * @param {string} opts.name 资产名
 */
function uploadAsset({ repo, tag, localPath, name }) {
  gh(['release', 'upload', tag, localPath], repo)
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