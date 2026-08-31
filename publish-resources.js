'use strict'

/**
 * 发布脚本 CLI
 * 用法：
 *   node publish-resources.js --manifest <json> [--keep N] [--dry-run] [--repo owner/repo] [--tag resources] [--offline]
 *   node publish-resources.js --help
 *
 * 在线来源：manifest 中未提供 version 且 sources 声明 upstream.kind==='online' 的资源，
 * 自动取上游最新构建日期作为版本（master-YYYYMMDD）；本地缺失平台资产时自动
 * 从在线源下载并重打包（--offline 可关闭）。
 */

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { publishFromManifest, readSourceInfo } = require('./lib/publish')
const upstream = require('./lib/upstream')

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
    if (!m) throw new Error(`参数解析失败：${a}`)
    const key = m[1].replace(/-/g, '')
    const next = argv[i + 1]
    out[key] = m[2] || (typeof next === 'string' && !next.startsWith('--') ? argv[++i] : true)
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
  --force        强制覆盖模式（允许覆写已存在版本资产与更新 sha256）
  --keep N       保留资源历史版本数（默认不裁剪）
  --dry-run      只计算并更新清单摘要，不执行上传
  --offline      禁用在线来源的自动下载/版本解析（本地缺失→计入 missing）
  --repo         资源仓库 owner/repo（默认 Leonard-Li777/firefly-resources）
  --tag          容器 tag（默认 resources）
`)
    process.exit(opts.help ? 0 : 1)
  }

  const sourcesRoot = path.resolve(__dirname, 'sources')
  const manifest = require(opts.manifest)
  const offline = !!opts.offline

  // 在线资源版本补齐：manifest 未提供 version 时取上游最新构建日期
  for (const rid of Object.keys(manifest.resources)) {
    const def = manifest.resources[rid]
    if (def.version) continue
    const source = readSourceInfo(sourcesRoot, rid)
    if (source && source.upstream && source.upstream.kind === 'online' && !offline) {
      def.version = await upstream.getBtbNMasterVersion()
      console.log(`[publish] ${rid} 未指定 version，自动取在线来源：${def.version}`)
    }
  }

  // 在线来源缺资产自动获取：BtbN 单二进制下载 → 提取 → 重打包 zip（raw/ 归档供 ffmpeg/ffprobe 复用）；
  // firefly-omni 系列（libmupdf / firefly-omni）经 gh CLI 从上游 Release 原样拉取后重命名归档。
  const cacheRoot = path.resolve(__dirname, '.upstream-cache')

  /**
   * 经 gh CLI 下载上游 Release 资产到本地缓存（幂等：目标存在即命中）
   * @param {object} opts
   * @returns {string} 本地缓存文件路径
   */
  function fetchUpstreamGhAsset({ repo, tag, assetName, cacheDir }) {
    fs.mkdirSync(cacheDir, { recursive: true })
    const dest = path.join(cacheDir, assetName)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest
    const res = spawnSync(
      'gh',
      ['release', 'download', tag, '--repo', repo, '--pattern', assetName, '--dir', cacheDir, '--clobber'],
      { encoding: 'utf8', stdio: 'pipe' }
    )
    if (res.status !== 0) {
      throw new Error(`gh release download 失败（${repo} ${tag} ${assetName}）：${(res.stderr || '').trim()}`)
    }
    return dest
  }

  const fetchOnline = async ({ resourceId, source, platformKey, version }) => {
    if (offline) return null
    const provider = source && source.upstream && source.upstream.provider
    if (provider === 'firefly-omni-ci-resources' || provider === 'firefly-omni-release') {
      const assetName = source.upstream.assetMap[platformKey]
      if (!assetName) return null
      const tag = source.upstream.tag || version
      return fetchUpstreamGhAsset({
        repo: source.upstream.repo,
        tag,
        assetName,
        cacheDir: path.join(cacheRoot, resourceId)
      })
    }
    if (provider === 'BtbN/FFmpeg-Builds') {
      const out = await upstream.fetchBtbNSingle({
        resourceId,
        version,
        platformKey,
        cacheDir: path.join(cacheRoot, 'shared')
      })
      return out
    }
    return null
  }

  const summary = await publishFromManifest({
    manifest,
    repo: opts.repo || 'Leonard-Li777/firefly-resources',
    tag: opts.tag || 'resources',
    dryRun: !!opts.dryrun,
    force: !!opts.force,
    keep: Number(opts.keep) || 0,
    fetchLocalPath: fetchOnline
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