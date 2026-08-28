'use strict'

/**
 * Release 说明"配套资源"区块渲染 CLI
 * 用法：node render-release-note.js --bom <path> [--repo owner/repo]
 * 输出 markdown 追加片，接入消费方 gh release create 流程。
 */

const path = require('path')
const { renderReleaseNote } = require('./lib/render')

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

function main() {
  const opts = parseArgs(args)
  if (opts.help || !opts.bom) {
    console.log(`
用法：node render-release-note.js --bom <path> [--repo owner/repo]
输出 Release 说明"配套资源"markdown 区块。
`)
    process.exit(opts.help ? 0 : 1)
  }
  const block = renderReleaseNote({
    bomPath: path.resolve(opts.bom),
    repo: opts.repo || 'Leonard-Li777/firefly-resources'
  })
  process.stdout.write(block + '\n')
}

main()