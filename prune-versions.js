'use strict'

/**
 * 一次性/周期性版本裁剪 CLI（不发布新版本，只按保留窗口清理历史）
 *
 * 用法：
 *   node prune-versions.js [--keep N] [--apply] [--resource id]
 *
 * 语义：
 *   - 每个资源保留「当前 latest + 上一版」（--keep N，默认 2），其余从 index.json 移除，
 *     并同步删除 GitHub Release 资产与 R2 对象（R2 需环境变量 R2_*）；
 *   - 默认 dry-run，只打印待删清单；--apply 才真正删除并回写 index.json；
 *   - latest 指向的版本永不裁剪（lib/index 内已有保护）。
 *
 * 依赖：gh CLI 已登录（仓库已转私有）；R2 缺失凭据时只删 GH 资产，并打印 R2 待删清单。
 */

const fs = require('fs')
const path = require('path')
const indexLib = require('./lib/index')
const gh = require('./lib/gh')
const r2 = require('./lib/r2')

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const keepArg =
  argv.find(a => a.startsWith('--keep=')) ||
  (argv.includes('--keep') ? argv[argv.indexOf('--keep') + 1] : null)
const keepRaw = keepArg ? String(keepArg).replace(/^--keep=?/, '') : null
const keep = keepRaw === null || keepRaw === '' ? 2 : Number(keepRaw)
const resourceArg =
  argv.find(a => a.startsWith('--resource=')) ||
  (argv.includes('--resource') ? argv[argv.indexOf('--resource') + 1] : null)
const onlyResource = resourceArg ? String(resourceArg).replace(/^--resource=?/, '') : null
const repo = 'Leonard-Li777/firefly-resources'
const tag = 'resources'
const indexPath = path.resolve(__dirname, 'index.json')

function human(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`
}

async function main() {
  if (!Number.isFinite(keep) || keep < 0) throw new Error(`--keep 非法：${keepRaw}`)
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  const ids = onlyResource ? [onlyResource] : Object.keys(index.resources)
  const plan = []
  let totalBytes = 0

  for (const id of ids) {
    const res = index.resources[id]
    if (!res) throw new Error(`资源不存在：${id}`)
    const prunable = indexLib.collectPrunableVersions(index, id, keep)
    if (prunable.versions.length === 0) continue
    let bytes = 0
    for (const v of prunable.versions) {
      for (const platformKey of Object.keys(res.versions[v])) {
        bytes += res.versions[v][platformKey].size || 0
      }
    }
    totalBytes += bytes
    plan.push({ id, versions: prunable.versions, assetNames: prunable.assetNames, bytes })
  }

  if (plan.length === 0) {
    console.log(`✅ 无需裁剪：全部资源都在 keep=${keep} 窗口内`)
    return
  }

  console.log(
    `${apply ? '🗑️ 执行' : '🔍 dry-run'}：保留 keep=${keep}（当前 latest + 上一版），待裁剪：`
  )
  for (const p of plan) {
    console.log(
      `  - ${p.id}: 删 ${p.versions.length} 版 [${p.versions.join(', ')}]，${p.assetNames.length} 个资产，${human(p.bytes)}`
    )
  }
  console.log(
    `合计回收：${human(totalBytes)}（${plan.reduce((s, p) => s + p.assetNames.length, 0)} 个资产）`
  )

  if (!apply) {
    console.log(
      'dry-run 结束：确认后加 --apply 执行（会删 GitHub Release 资产 + R2 对象并回写 index.json）'
    )
    return
  }

  // 先落索引，避免删完资产后索引仍指向已删文件
  for (const p of plan) indexLib.removeVersions(index, p.id, p.versions)
  indexLib.writeIndexFile(indexPath, index)
  console.log('✅ index.json 已回写')

  for (const p of plan) {
    gh.deleteAssets(repo, tag, p.assetNames)
  }
  console.log('✅ GitHub Release 资产已处理')

  if (r2.isConfigured()) {
    for (const p of plan) {
      await r2.deleteAssets(p.assetNames)
    }
    console.log('✅ R2 对象已处理')
  } else {
    console.log('⚠️ 未检测到 R2 凭据，R2 对象未删除。请在根仓执行：')
    console.log(
      `   node scripts/sync-firefly-resources-to-r2.js --delete=${plan.flatMap(p => p.assetNames).join(',')}`
    )
  }
}

main().catch(e => {
  console.error(`[prune] 失败：${e.message}`)
  process.exit(1)
})
