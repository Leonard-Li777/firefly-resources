'use strict'

/**
 * 发版前置校验 CLI（消费方 Release 创建前执行）
 * 用法：
 *   node verify-release-resources.js --bom <path> --index-local <index.json>
 *   node verify-release-resources.js --bom <path> --repo Leonard-Li777/firefly-resources
 */

const { verifyBom } = require('./lib/verify')

const args = process.argv.slice(2)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/)
    if (!m) throw new Error(`参数解析失败：${a}`)
    const key = m[1].replace(/-/g, '')
    out[key] = m[2] || argv[++i]
  }
  return out
}

async function main() {
  const opts = parseArgs(args)
  if (opts.help || (!opts.bom) || (!opts.indexlocal && !opts.repo)) {
    console.log(`
用法：node verify-release-resources.js --bom <path> (--index-local <json> | --repo owner/repo)

必填：
  --bom          装配清单 resources.bom.json 路径
  --index-local  本地索引文件路径（离线校验）
  --repo         远程资源仓库 owner/repo（拉取 main 分支索引）
`)
    process.exit(opts.help ? 0 : 1)
  }

  try {
    const result = await verifyBom({
      bomPath: opts.bom,
      indexPath: opts.indexlocal || undefined,
      remoteRepo: opts.repo || undefined
    })
    for (const c of result.resources) {
      console.log(`  ${c.mode === 'upstream' ? '⭮' : c.ok ? '✓' : '✗'} ${c.resourceId} ${c.version} ${c.name}`)
    }
    console.log(`[verify] index sha256：${result.indexSha256}`)
    if (result.ok) {
      console.log('[verify] ✓ 装配清单与资源索引一致')
      process.exit(0)
    } else {
      for (const e of result.errors) console.error(`  ✗ ${e}`)
      console.error('[verify] ✗ 校验未通过，中断发版')
      process.exit(1)
    }
  } catch (e) {
    console.error(`[verify] 失败：${e.message}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(`[verify] 失败：${e.message}`)
  process.exit(1)
})