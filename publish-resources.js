'use strict'

/**
 * 发布脚本 CLI
 * 用法：
 *   node publish-resources.js --manifest <json> [--keep N] [--dry-run] [--repo owner/repo] [--tag resources] [--offline]
 *   node publish-resources.js --upstream <ids|all> [--keep N] [--dry-run] [--offline]
 *   node publish-resources.js --help
 *
 * --manifest：手工/迁移发布清单（assets 可给本地路径，缺路径时走在线来源自动下载）。
 * --upstream：按 sources/<id>.json 的上游规则构造清单，以 index 中的当前版本重新拉取资产并对账重发；
 *             all 只覆盖「在线 + 声明 platforms/assetMap + 非 deprecated」子集，跳过项逐条打印原因。
 * 在线来源：manifest 中未提供 version 且 sources 声明 upstream.kind==='online' 的资源，
 * 自动取上游最新构建日期作为版本（master-YYYYMMDD）；本地缺失平台资产时自动
 * 从在线源下载并重打包（--offline 可关闭）。
 */

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { publishFromManifest, readSourceInfo } = require('./lib/publish')
const indexLib = require('./lib/index')
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

/**
 * 读取 sources 目录下全部资源 ID
 * @param {string} sourcesRoot sources 目录
 * @returns {string[]}
 */
function listSourceIds(sourcesRoot) {
  return fs
    .readdirSync(sourcesRoot)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/i, ''))
}

/**
 * 取上游平台清单：BtbN 用 upstream.platforms，其余用 upstream.assetMap
 * @param {object} source sources/<id>.json 内容
 * @returns {object|null}
 */
function platformMapOf(source) {
  const up = source && source.upstream
  if (!up) return null
  for (const key of ['platforms', 'assetMap']) {
    if (up[key] && typeof up[key] === 'object') return up[key]
  }
  return null
}

/**
 * 由上游文件名推断归档扩展名；BtbN 单文件下载会被重打包为 zip
 * @param {string} name 上游资产名（可含 {tag}）
 * @param {string} provider 上游 provider
 * @returns {string}
 */
function extOf(name, provider) {
  if (provider === 'BtbN/FFmpeg-Builds') return 'zip'
  const m = String(name || '').match(/\.(tar\.gz|tar\.xz|tgz|zip|7z)$/i)
  return m ? m[1].toLowerCase() : 'zip'
}

/**
 * 取索引中某资源的当前版本（latest 具体版本优先，其次最大版本）
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @returns {string|null}
 */
function latestIndexVersion(index, resourceId) {
  const res = index.resources && index.resources[resourceId]
  if (!res) return null
  const keys = indexLib.sortVersions(Object.keys(res.versions || {}))
  if (res.latest && res.latest !== 'latest' && keys.includes(res.latest)) return res.latest
  return keys.length > 0 ? keys[keys.length - 1] : null
}

/**
 * 由 sources 构造发布清单（--upstream 模式）
 *
 * 语义：按索引中的当前版本，从各资源声明的上游来源重新拉取资产并归档发布，
 * 用于「远端资产缺失/漂移时的对账重发」；新版本的生产仍由各资源自己的构建流水线驱动。
 *
 * @param {object} opts
 * @param {string} opts.sourcesRoot sources 目录
 * @param {object} opts.index 当前索引
 * @param {string[]} [opts.ids] 指定资源 ID；缺省 = 全部可自动发布资源
 * @param {string} [opts.version] 仅在指定单个资源时允许强制版本
 * @param {boolean} [opts.strict] 缺省按 ids 自动判定：all → 宽松（跳过项列明），显式 id → 严格（不可静默跳过）
 * @param {Function} [opts.resolveOnlineVersion] 索引无版本且上游无 tag 时的兜底解析
 * @returns {Promise<{manifest: object, skipped: Array<{resourceId: string, reason: string}>, problems: Array<{resourceId: string, reason: string}>}>}
 */
async function buildUpstreamManifest({
  sourcesRoot,
  index,
  ids,
  version,
  strict,
  resolveOnlineVersion = async ({ source }) => {
    if (source && source.upstream && source.upstream.provider === 'BtbN/FFmpeg-Builds') {
      return upstream.getBtbNMasterVersion()
    }
    return null
  }
}) {
  const allIds = listSourceIds(sourcesRoot)
  const idList = Array.isArray(ids)
    ? ids
    : typeof ids === 'string'
      ? ids
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : []
  const wanted =
    idList.length === 0 || (idList.length === 1 && idList[0] === 'all') ? allIds : idList
  // 未显式传 strict 时：all 模式按能力子集发布（跳过项列明），显式指定则不允许静默跳过
  const strictMode = strict === undefined ? !(idList.length === 1 && idList[0] === 'all') : strict
  if (version && wanted.length > 1) {
    throw new Error('--version 只能与单个资源一起使用（多资源请逐个指定）')
  }
  const manifest = { resources: {} }
  const skipped = []
  const problems = []
  // 显式指定资源时不允许静默跳过（strict）；all 模式只做可自动发布子集，其余显式列出跳过原因
  const reportSkip = (resourceId, reason) => {
    if (strictMode) problems.push({ resourceId, reason: `${reason}（显式指定时不可静默跳过）` })
    else skipped.push({ resourceId, reason })
  }

  for (const resourceId of wanted) {
    const source = readSourceInfo(sourcesRoot, resourceId)
    if (!source) {
      problems.push({ resourceId, reason: 'sources 中不存在该资源定义' })
      continue
    }
    const up = source.upstream || {}
    if (source.deprecated) {
      reportSkip(resourceId, 'sources 已标注 deprecated，禁止发布')
      continue
    }
    if (up.kind !== 'online') {
      reportSkip(
        resourceId,
        `上游非在线来源（kind=${up.kind || 'missing'}），需本地 --manifest 发布`
      )
      continue
    }
    const platformMap = platformMapOf(source)
    if (!platformMap) {
      reportSkip(resourceId, '上游未声明平台清单/资产映射（直链或手工来源）')
      continue
    }
    const resolvedVersion = version || latestIndexVersion(index, resourceId) || up.tag || null
    const finalVersion = resolvedVersion || (await resolveOnlineVersion({ source, resourceId }))
    if (!finalVersion) {
      const reason = '无法确定版本：索引无记录，上游也未声明 tag，且无自动版本解析规则'
      if (strictMode) problems.push({ resourceId, reason })
      else skipped.push({ resourceId, reason: `${reason}（all 模式下跳过）` })
      continue
    }
    const assets = {}
    let ext = 'zip'
    for (const platformKey of Object.keys(platformMap)) {
      const upstreamName = String(platformMap[platformKey] || '').replace(/\{tag\}/g, finalVersion)
      const platformExt = extOf(upstreamName, up.provider)
      ext = platformExt
      assets[platformKey] = { path: null, ext: platformExt }
    }
    const distinctExts = new Set(Object.values(assets).map(a => a.ext))
    manifest.resources[resourceId] = {
      version: finalVersion,
      ext: distinctExts.size === 1 ? [...distinctExts][0] : ext,
      assets
    }
  }

  return { manifest, skipped, problems }
}

async function main() {
  const opts = parseArgs(args)
  if (opts.help || (!opts.manifest && !opts.upstream)) {
    console.log(`
用法：node publish-resources.js --manifest <json> [options]
      node publish-resources.js --upstream <ids|all> [options]

必填（二选一）：
  --manifest     发布清单（resources: id → {version, ext, assets{platformKey: 本地文件路径}}）
  --upstream      按 sources/<id>.json 的上游规则构造清单并拉取资产（逗号分隔或 all）

可选：
  --force        强制覆盖模式（允许覆写已存在版本资产与更新 sha256）
  --keep N       保留资源历史版本数（默认 2 = 当前最新 + 上一版；传 0 关闭裁剪）
  --dry-run      只计算并更新清单摘要，不执行上传
  --offline      禁用在线来源的自动下载/版本解析（本地缺失→计入 missing）
  --repo         资源仓库 owner/repo（默认 Leonard-Li777/firefly-resources）
  --tag          容器 tag（默认 resources）
`)
    process.exit(opts.help ? 0 : 1)
  }

  const sourcesRoot = path.resolve(__dirname, 'sources')
  const offline = !!opts.offline
  let manifest

  if (opts.manifest) {
    manifest = require(opts.manifest)
  } else {
    const ids = String(opts.upstream === true ? 'all' : opts.upstream)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const indexPath = path.resolve(__dirname, 'index.json')
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    const built = await buildUpstreamManifest({
      sourcesRoot,
      index,
      ids,
      version: typeof opts.version === 'string' ? opts.version : undefined,
      strict: !(ids.length === 1 && ids[0] === 'all')
    })
    for (const s of built.skipped) console.log(`[upstream] 跳过 ${s.resourceId}：${s.reason}`)
    for (const p of built.problems) console.log(`[upstream] ✗ ${p.resourceId}：${p.reason}`)
    if (built.problems.length > 0) {
      console.error(
        '[upstream] 存在无法自动发布的资源，已中止（请显式指定 ids 或补 sources 上游规则）'
      )
      process.exit(1)
    }
    manifest = built.manifest
    if (Object.keys(manifest.resources).length === 0) {
      console.error('[upstream] 没有可自动发布的资源')
      process.exit(1)
    }
  }

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
  // firefly-omni 系列（libmupdf / firefly-omni）与通用 github-release provider（如 llama-model-download）
  // 经 gh CLI 从上游 Release 原样拉取后按 assetMap 归档。
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
      [
        'release',
        'download',
        tag,
        '--repo',
        repo,
        '--pattern',
        assetName,
        '--dir',
        cacheDir,
        '--clobber'
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    )
    if (res.status !== 0) {
      throw new Error(
        `gh release download 失败（${repo} ${tag} ${assetName}）：${(res.stderr || '').trim()}`
      )
    }
    return dest
  }

  const fetchOnline = async ({ resourceId, source, platformKey, version }) => {
    if (offline) return null
    const provider = source && source.upstream && source.upstream.provider
    if (
      provider === 'firefly-omni-ci-resources' ||
      provider === 'firefly-omni-release' ||
      provider === 'github-release'
    ) {
      const rawName = source.upstream.assetMap[platformKey]
      if (!rawName) return null
      // 支持 {tag} 模板（llama-cpp 等按构建号命名的上游资产）
      const assetName = String(rawName).replace(/\{tag\}/g, version)
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
    keep: opts.keep === undefined || opts.keep === '' ? 2 : Number(opts.keep),
    fetchLocalPath: fetchOnline
  })

  const line = `上传 ${summary.uploaded.length}，幂等跳过 ${summary.skipped.length}，本地缺失 ${summary.missing.length}`
  console.log(`[publish] ${line}`)
  for (const m of summary.uploaded) console.log(`  ↑ ${m.name} (${m.sha256}) ${m.size} B`)
  for (const m of summary.skipped) console.log(`  • 已存在，跳过 ${m.name}`)
  for (const m of summary.missing) console.log(`  ✗ 本地文件缺失 ${m.localPath || m.name}`)
  for (const m of summary.errors) console.log(`  ✗ 错误 ${m.resourceId} ${m.name}: ${m.message}`)
  if (
    summary.r2Uploaded &&
    (summary.r2Uploaded.length > 0 || summary.r2Skipped.length > 0 || summary.r2Errors.length > 0)
  ) {
    console.log(
      `[publish-r2] Cloudflare R2 同步：上传 ${summary.r2Uploaded.length}，跳过 ${summary.r2Skipped.length}，错误 ${summary.r2Errors.length}`
    )
    for (const m of summary.r2Uploaded) console.log(`  ☁️↑ [R2] ${m.name} (${m.size} B)`)
    for (const m of summary.r2Skipped) console.log(`  ☁️• [R2] 已存在，跳过 ${m.name}`)
    for (const m of summary.r2Errors) console.log(`  ☁️✗ [R2] 错误 ${m.name}: ${m.message}`)
  }
  console.log(`[publish] 索引已更新：${summary.indexUpdatedAt}`)

  if (summary.errors.length > 0) process.exitCode = 1
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[publish] 失败：${e.message}`)
    process.exit(1)
  })
}

module.exports = { buildUpstreamManifest, platformMapOf, extOf, latestIndexVersion }
