'use strict'

const fs = require('fs')

const indexLib = require('./index')
const hashLib = require('./hash')

/**
 * 发版前置校验逻辑：装配清单 ↔ 仓库索引一致性
 * 仅校验外部可观察契约（BOM 的 indexSha / 资产名 / sha256），不触碰装配实现细节。
 */

const RAW_INDEX_URL = (repo, branch = 'main') =>
  `https://raw.githubusercontent.com/${repo}/${branch}/index.json`

/**
 * 拉取远程索引原文（node 18+ 内置 fetch）
 * @param {string} repo 完整仓库名
 * @param {string} branch 分支
 * @returns {Promise<{text: string, index: object}>}
 */
async function fetchRemoteIndex(repo, branch = 'main') {
  const res = await fetch(RAW_INDEX_URL(repo, branch))
  if (!res.ok) {
    throw new Error(`[verify] 拉取远程索引失败：${res.status} ${res.statusText} (${RAW_INDEX_URL(repo, branch)})`)
  }
  const text = await res.text()
  return { text, index: JSON.parse(text) }
}

/**
 * 执行装配清单校验
 * @param {object} opts
 * @param {string} opts.bomPath 装配清单路径
 * @param {string} [opts.indexPath] 本地索引路径（与 remoteRepo 二选一）
 * @param {string} [opts.remoteRepo] 远程仓库（拉取 main 分支原始索引）
 * @returns {Promise<object>} {ok, indexSha256, indexShaOk, resources, errors}
 */
async function verifyBom({ bomPath, indexPath, remoteRepo }) {
  if (!bomPath) throw new Error('[verify] 缺少 --bom 路径')
  if (!indexPath && !remoteRepo) throw new Error('[verify] 需提供 --index-local 或 --repo')

  const bom = JSON.parse(fs.readFileSync(bomPath, 'utf8'))

  let index
  let indexSha256
  if (indexPath) {
    const text = fs.readFileSync(indexPath, 'utf8')
    index = JSON.parse(text)
    indexSha256 = hashLib.sha256Text(text)
  } else {
    const { text, index: remote } = await fetchRemoteIndex(remoteRepo)
    index = remote
    indexSha256 = hashLib.sha256Text(text)
  }

  const errors = []
  const checks = []

  if (!bom.resources || !Array.isArray(bom.resources)) {
    errors.push('[verify] BOM 缺少 resources 数组')
    return { ok: false, indexSha256, indexShaOk: false, resources: [], errors }
  }

  // 索引 sha 一致性（BOM 未记录时不强制）
  const indexShaOk = !bom.indexSha256 || bom.indexSha256 === indexSha256
  if (!indexShaOk) {
    errors.push(
      `[verify] BOM 记录索引 sha256 与当前索引不一致：${bom.indexSha256} ≠ ${indexSha256}（资源索引已更新，需重新发布本版本资源）`
    )
  }

  for (const item of bom.resources) {
    const source = item.source
    if (source === 'upstream') {
      checks.push({ resourceId: item.id, version: item.version, mode: 'upstream', ok: true, name: item.asset || 'n/a' })
      continue
    }
    const hit = indexLib.hasAssetWithSha(index, item.id, item.asset, item.sha256)
    checks.push({ resourceId: item.id, version: item.version, mode: 'index', ok: hit, name: item.asset })
    if (!hit) {
      errors.push(`[verify] BOM 资源未在索引命中：${item.id} ${item.version} ${item.asset} (sha256 ${item.sha256.slice(0, 12)}…)`)
    }
  }

  return { ok: indexShaOk && errors.length === 0, indexSha256, indexShaOk, resources: checks, errors }
}

module.exports = { verifyBom, fetchRemoteIndex, RAW_INDEX_URL }