'use strict'

const fs = require('fs')

/**
 * Release 说明"配套资源"区块渲染。
 * BOM → markdown 资源表；共享资源列资产名 + sha256（仓库已转私有：不输出对外下载链接，
 * 匿名访问 github.com 下载地址会 404，仅列资产名供有权限的消费方核对），非共享资源标"上游直拉"。
 */

const DEFAULT_REPO = 'Leonard-Li777/firefly-resources'
const DEFAULT_TAG = 'resources'

/**
 * 从 BOM 条目提取 sha256（兼容扁平 item.sha256 与 v1 asset 对象内嵌 sha256）
 * @param {object} item
 * @returns {string}
 */
function extractSha(item) {
  if (item.sha256) return item.sha256
  if (item.asset && typeof item.asset === 'object' && item.asset.sha256) return item.asset.sha256
  return ''
}

/**
 * 渲染资源说明区块
 * @param {object} opts
 * @param {string} opts.bomPath 装配清单路径
 * @param {string} [opts.repo] 资源仓库（默认 firefly-resources）
 * @returns {string} markdown 区块
 */
function renderReleaseNote({ bomPath, repo = DEFAULT_REPO }) {
  const bom = JSON.parse(fs.readFileSync(bomPath, 'utf8'))
  const tag = (bom.resourcePackage && bom.resourcePackage.containerTag) || DEFAULT_TAG
  const rows = []

  // 兼容两种 BOM schema：旧版扁平数组 / 新版 v1 对象映射（resources: { id: {...} }）
  const rawResources = bom.resources || []
  const entries = Array.isArray(rawResources)
    ? rawResources
    : Object.entries(rawResources).map(([id, r]) => ({ id, ...r }))

  for (const item of entries) {
    if (item.source === 'upstream') {
      const upAsset = typeof item.asset === 'object' && item.asset ? item.asset.name : item.asset
      rows.push(
        `| ${item.id} | ${item.version} | 上游直拉 | ${upAsset || item.url || 'n/a'} | ${extractSha(item).slice(0, 8)} |`
      )
      continue
    }
    // 私有仓库：只列资产名，不生成 github.com 下载链接
    const assetName = typeof item.asset === 'object' && item.asset ? item.asset.name : item.asset
    rows.push(`| ${item.id} | ${item.version} | 容器分发 | ${assetName || 'n/a'} | ${extractSha(item).slice(0, 8)} |`)
  }

  const lines = [
    '## 配套资源',
    '',
    `- 资源仓库：\`${repo}\`@\`${tag}\`${bom.indexSha256 ? `，index sha256 \`${bom.indexSha256}\`` : ''}（闭源仓库，需授权访问）`,
    `- 装配清单：[resources.bom.json](assets/resources.bom.json)`,
    '',
    '| 资源 | 版本 | 来源 | 资产 | sha256 前缀 |',
    '|---|---|---|---|---|',
    ...rows
  ]
  return lines.join('\n')
}

module.exports = { renderReleaseNote }