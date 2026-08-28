'use strict'

/**
 * 发布脚本 CLI
 * 用法：
 *   node publish-resources.js --manifest <json> [--keep N] [--dry-run] [--repo owner/repo] [--tag resources]
 *   node publish-resources.js --help
 */

const path = require('path')
const { publishFromManifest } = require('./lib/publish')

const args = process.argv.slice(2)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/)
    if (!m || typeof argv[i + 1] === 'undefined') throw new Error(`参数解析失败：${a}`)
    const key = m[1].replace(/-/g, '')
    out[key] = m[2] || argv[++i]
    if (out[key] === 'true') out[key] = true
    if (out[key] === 'false') out[key] = false
  }
  if (out.manifest) out.manifest = path.resolve(out.manifest)
  return out
}

async function main() {
  const opts = parseArgs(args)
  if (opts.help || !opts.manifest) {
    console.log(`
用法：node publish-resources.js --manifest <json> [options]

必填：
  --manifest     发布清单（resources: id → {version, ext, assets{platformKey: 本地文件路径}}）

可选：
  --keep N       保留资源历史版本数（默认不裁剪）
  --dry-run      只计算并更新清单摘要，不执行上传
  --repo         资源仓库 owner/repo（默认 Leonard-Li777/firefly-resources）
  --tag          容器 tag（默认 resources）
`)
    process.exit(opts.help ? 0 : 1)
  }

  const manifest = require(opts.manifest)
  const summary = await publishFromManifest({
    manifest,
    repo: opts.repo || 'Leonard-Li777/firefly-resources',
    tag: opts.tag || 'resources',
    dryRun: !!opts.dryrun,
    keep: Number(opts.keep) || 0
  })

  const line = `上传 ${summary.uploaded.length}，幂等跳过 ${summary.skipped.length}，本地缺失 ${summary.missing.length}`
  console.log(`[publish] ${line}`)
  for (const m of summary.uploaded) console.log(`  ↑ ${m.name} (${m.sha256}) ${m.size} B`)
  for (const m of summary.skipped) console.log(`  • 已存在，跳过 ${m.name}`)
  for (const m of summary.missing) console.log(`  ✗ 本地文件缺失 ${m.localPath}`)
  for (const m of summary.errors) console.log(`  ✗ 错误 ${m.resourceId} ${m.name}: ${m.message}`)
  for (const p of summary.pruned) console.log(`  ♻ 裁剪 ${p.resourceId}: ${p.versions.join(', ')}`)
  console.log(`[publish] 索引已更新：${summary.indexUpdatedAt}`)

  if (summary.errors.length > 0) process.exitCode = 1
}

main().catch(e => {
  console.error(`[publish] 失败：${e.message}`)
  process.exit(1)
})