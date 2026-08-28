'use strict'

const fs = require('fs')

/**
 * Release 说明"配套资源"区块渲染。
 * BOM → markdown 资源表；共享资源链接到容器 tag 资产，非共享资源标"上游直拉"。
 */

const DEFAULT_REPO = 'Leonard-Li777/firefly-resources'
const DEFAULT_TAG = 'resources'

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

  for (const item of bom.resources || []) {
    if (item.source === 'upstream') {
      rows.push(
        `| ${item.id} | ${item.version} | 上游直拉 | ${item.asset || item.url || 'n/a'} | ${(item.sha256 || '').slice(0, 8)} |`
      )
      continue
    }
    const url = item.url || `https://github.com/${repo}/releases/download/${tag}/${item.asset}`
    rows.push(`| ${item.id} | ${item.version} | [${item.asset}](${url}) | ${(item.sha256 || '').slice(0, 8)} |`)
  }

  const indexUrl = `https://github.com/${repo}/releases/tag/${tag}`
  const lines = [
    '## 配套资源',
    '',
    `- 索引：[${repo}@${tag}](${indexUrl})${bom.indexSha256 ? `，index sha256 \`${bom.indexSha256}\`` : ''}`,
    `- 装配清单：[resources.bom.json](assets/resources.bom.json)`,
    '',
    '| 资源 | 版本 | 资产 | sha256 前缀 |',
    '|---|---|---|---|',
    ...rows
  ]
  return lines.join('\n')
}

module.exports = { renderReleaseNote }