#!/usr/bin/env node
'use strict'

/**
 * 统一产品资源声明式装配 CLI
 *
 * 用法：
 *   node assemble-product.js --product <desktop|omni-ce|engine> --target-root <dir>
 *     [--mode <release-locked|dev-local>] [--lockfile <path>] [--index-local <path>]
 *     [--preset-dir <dir>] [--platform <p>] [--arch <a>] [--dry-run]
 */

const path = require('path')
const { assembleProduct } = require('./lib/product-assembler')

function parseArgs(argv) {
  const opts = { mode: 'release-locked', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--product') opts.product = argv[++i]
    else if (a === '--mode') opts.mode = argv[++i]
    else if (a === '--target-root' || a === '--target') opts.targetRoot = path.resolve(argv[++i])
    else if (a === '--lockfile') opts.lockfilePath = path.resolve(argv[++i])
    else if (a === '--index-local') opts.indexPath = path.resolve(argv[++i])
    else if (a === '--preset-dir') opts.presetDir = path.resolve(argv[++i])
    else if (a === '--platform') opts.platform = argv[++i]
    else if (a === '--arch') opts.arch = argv[++i]
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--help' || a === '-h') opts.help = true
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.product || !opts.targetRoot) {
    console.log(
      '用法: node assemble-product.js --product <desktop|omni-ce|engine> --target-root <dir> [--mode release-locked|dev-local] [--lockfile <path>] [--index-local <path>] [--preset-dir <dir>] [--dry-run]'
    )
    process.exit(opts.help ? 0 : 1)
  }

  const result = await assembleProduct(opts)
  console.log(
    `✅ 产品装配完成: product=${result.product}, mode=${result.mode}, target=${result.targetRoot}` +
      (result.skipped.length ? `, 幂等跳过=${result.skipped.join(',')}` : '')
  )
}

main().catch(err => {
  console.error(`❌ 产品装配失败: ${err.message}`)
  process.exit(1)
})
