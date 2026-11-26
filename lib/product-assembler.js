'use strict'

/**
 * 声明式多产品资源装配深模块 (ProductResourceAssembler)
 *
 * 唯一对外接口：
 * - loadProductManifest(product, productsDir)
 * - resolveTopLevelResourceDirs(product, productsDir)
 * - assembleProduct(options)
 * - signDevLocalManifest(options)
 * - verifyDirectoryManifest(dirPath, options)
 *
 * 设计不变量（docs/specs/multi-product-resource-placement-and-assembly-spec.md）：
 * 1. 构件（Artifact）与产品（Product）正交分层，拒绝存在 omni-pro 产品清单；
 * 2. 同目标目录的多构件（如 bin/omni）统一合并写入唯一 `.manifest-<dir>.json` v3（strictExclusive=true），
 *    装配结束自动清理清单外残留文件，阻断旧版 DLL 污染；
 * 3. `release-locked` 与 `dev-local` 双适配器隔离：`dev-local` 写入模式凭据与 gitSha 防止被旧锁回退覆写，
 *    且 `NODE_ENV=production` 时严格拒绝任何 `dev-local` 产物进入发布包。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const indexLib = require('./index')
const namingLib = require('./naming')
const { authHeaders } = require('./auth')

const PRODUCTS_DIR = path.resolve(__dirname, '../products')
const DEFAULT_INDEX_PATH = path.resolve(__dirname, '../index.json')
const SUPPORTED_PRODUCTS = new Set(['desktop', 'omni-ce', 'engine'])
const MANIFEST_SCHEMA_VERSION = 3

function sha256FileSync(filePath) {
  const hash = crypto.createHash('sha256')
  const buf = fs.readFileSync(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

function getManifestPathForDir(dirPath) {
  return path.join(dirPath, `.manifest-${path.basename(dirPath)}.json`)
}

function getReadyMarkerPrefix(dirPath) {
  return `.ready-${path.basename(dirPath)}-`
}

/**
 * 校验并加载指定产品声明清单
 * @param {string} product 'desktop' | 'omni-ce' | 'engine'
 * @param {string} [productsDir]
 */
function loadProductManifest(product, productsDir = PRODUCTS_DIR) {
  if (!SUPPORTED_PRODUCTS.has(product)) {
    throw new Error(
      `[assembler] 不支持的产品类型: "${product}"（仅允许 desktop | omni-ce | engine，严禁构建独立 omni-pro 产品包）`
    )
  }
  const filePath = path.join(productsDir, `${product}.resources.json`)
  if (!fs.existsSync(filePath)) {
    throw new Error(`[assembler] 缺失产品声明清单: ${filePath}`)
  }
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (manifest.product !== product || !Array.isArray(manifest.entries)) {
    throw new Error(`[assembler] 产品清单格式非法: ${filePath}`)
  }
  return manifest
}

/**
 * 从产品清单派生 Electron/打包器所需的一级静态资源目录集合（去重、确定性排序）
 * @param {string} product
 * @param {string} [prefix='build/extraResources']
 * @param {string} [productsDir]
 * @returns {string[]}
 */
function resolveTopLevelResourceDirs(product, prefix = 'build/extraResources', productsDir = PRODUCTS_DIR) {
  const manifest = loadProductManifest(product, productsDir)
  const topDirs = new Set()
  for (const entry of manifest.entries) {
    const dest = String(entry.dest || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!dest) continue
    const top = dest.split('/')[0]
    if (top) topDirs.add(top)
  }
  return Array.from(topDirs)
    .sort()
    .map(d => (prefix ? `${prefix.replace(/\/+$/, '')}/${d}` : d))
}

function resolveTargetPlatformKeys(platform = process.platform, arch = process.arch) {
  const key = namingLib.inferPlatformKey(platform, arch)
  const keys = []
  if (key) keys.push(key)
  if (platform === 'darwin' && !keys.includes('darwin-universal')) {
    keys.push('darwin-universal')
  }
  keys.push(namingLib.DEFAULT_KEY)
  return keys
}

/**
 * 收集目录内所有普通业务文件（忽略 .manifest-* / .ready-* / .txn.json 标记）
 */
function collectBusinessFiles(dirPath, relPrefix = '') {
  if (!fs.existsSync(dirPath)) return []
  const out = []
  for (const name of fs.readdirSync(dirPath)) {
    if (
      name.startsWith('.manifest-') ||
      name.startsWith('.ready-') ||
      name.startsWith('.integrity-') ||
      name === '.txn.json'
    ) {
      continue
    }
    const abs = path.join(dirPath, name)
    const stat = fs.statSync(abs)
    const rel = relPrefix ? `${relPrefix}/${name}` : name
    if (stat.isDirectory()) {
      out.push(...collectBusinessFiles(abs, rel))
    } else if (stat.isFile()) {
      out.push({ relPath: rel, abs, size: stat.size })
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/**
 * 写入目录独占合并完整性清单（v3）
 */
function writeDirectoryManifest({
  dirPath,
  targetRel,
  assemblyMode,
  sources,
  strictExclusive = true,
  gitSha = null
}) {
  fs.mkdirSync(dirPath, { recursive: true })
  const files = collectBusinessFiles(dirPath).map(f => ({
    relPath: f.relPath,
    size: f.size,
    sha256: sha256FileSync(f.abs)
  }))

  // 清除旧 .ready-<dir>-* 标记，写入新的复合哈希标记
  const prefix = getReadyMarkerPrefix(dirPath)
  for (const name of fs.readdirSync(dirPath)) {
    if (name.startsWith(prefix)) {
      fs.unlinkSync(path.join(dirPath, name))
    }
  }
  const compositeInput = JSON.stringify({ assemblyMode, sources, files })
  const compositeHash = crypto.createHash('sha256').update(compositeInput).digest('hex').slice(0, 16)
  fs.writeFileSync(path.join(dirPath, `${prefix}${compositeHash}`), `${assemblyMode}:${compositeHash}\n`, 'utf8')

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    targetDir: targetRel,
    assemblyMode,
    ...(gitSha ? { gitSha } : {}),
    sources,
    strictExclusive,
    createdAt: new Date().toISOString(),
    files
  }
  const manifestPath = getManifestPathForDir(dirPath)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return manifest
}

/**
 * 校验目录独占清单（支持严格排他检测与 dev-local 模式识别）
 */
function verifyDirectoryManifest(dirPath, options = {}) {
  const { strictExclusive = true, forbidDevLocal = false } = options
  const manifestPath = getManifestPathForDir(dirPath)
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'missing_manifest', errors: [`清单缺失: ${manifestPath}`], extraFiles: [] }
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return { ok: false, reason: 'corrupt_manifest', errors: [`清单损坏: ${err.message}`], extraFiles: [] }
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
    return {
      ok: false,
      reason: 'legacy_or_invalid_manifest',
      errors: [`清单 schema 不兼容: ${manifest.schemaVersion}`],
      extraFiles: []
    }
  }

  if (forbidDevLocal && manifest.assemblyMode === 'dev-local') {
    return {
      ok: false,
      reason: 'dev_local_forbidden_in_production',
      errors: [`禁止在生产模式放行 dev-local 覆盖目录: ${dirPath} (gitSha=${manifest.gitSha || 'unknown'})`],
      extraFiles: []
    }
  }

  const errors = []
  const declared = new Map(manifest.files.map(f => [f.relPath, f]))
  const onDisk = collectBusinessFiles(dirPath)
  const diskMap = new Map(onDisk.map(f => [f.relPath, f]))

  for (const [rel, expected] of declared) {
    const actual = diskMap.get(rel)
    if (!actual) {
      errors.push(`缺失文件: ${rel}`)
      continue
    }
    if (actual.size !== expected.size) {
      errors.push(`文件大小漂移: ${rel} (expected=${expected.size}, actual=${actual.size})`)
      continue
    }
    const sha = sha256FileSync(actual.abs)
    if (sha !== expected.sha256) {
      errors.push(`SHA-256 漂移: ${rel}`)
    }
  }

  const extraFiles = onDisk.filter(f => !declared.has(f.relPath)).map(f => f.relPath)
  if (strictExclusive && extraFiles.length > 0) {
    errors.push(`存在清单外污染文件: ${extraFiles.join(', ')}`)
  }

  return {
    ok: errors.length === 0,
    assemblyMode: manifest.assemblyMode,
    manifest,
    errors,
    extraFiles
  }
}

/**
 * 清理不在清单中的多余污染文件（独占目录保护）
 */
function purgeUntrackedFiles(dirPath, allowedRelPaths) {
  const allowedSet = new Set(allowedRelPaths)
  const onDisk = collectBusinessFiles(dirPath)
  const removed = []
  for (const file of onDisk) {
    if (!allowedSet.has(file.relPath)) {
      fs.unlinkSync(file.abs)
      removed.push(file.relPath)
    }
  }
  return removed
}

/**
 * 默认跨平台归档解压（.zip / .tar.gz / .tgz）
 */
function defaultExtractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const res = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { encoding: 'utf8', stdio: 'pipe' })
    if (res.status !== 0) {
      throw new Error(`[assembler] tar 解压失败 (${archivePath}): ${res.stderr || res.stdout}`)
    }
    return
  }
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const escapedSrc = archivePath.replace(/'/g, "''")
      const escapedDest = destDir.replace(/'/g, "''")
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${escapedSrc}' -DestinationPath '${escapedDest}' -Force`],
        { encoding: 'utf8', stdio: 'pipe' }
      )
      if (res.status !== 0) {
        throw new Error(`[assembler] Expand-Archive 解压失败 (${archivePath}): ${res.stderr || res.stdout}`)
      }
      return
    }
    const res = spawnSync('unzip', ['-o', '-q', archivePath, '-d', destDir], { encoding: 'utf8', stdio: 'pipe' })
    if (res.status !== 0) {
      throw new Error(`[assembler] unzip 解压失败 (${archivePath}): ${res.stderr || res.stdout}`)
    }
    return
  }
  throw new Error(`[assembler] 不支持的归档格式: ${archivePath}`)
}

async function defaultDownloadAsset({ repo, containerTag, assetName, destPath }) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${containerTag}`
  const res = await fetch(apiUrl, {
    headers: authHeaders({
      'user-agent': 'firefly-resource-assembler',
      accept: 'application/vnd.github+json'
    })
  })
  if (!res.ok) {
    throw new Error(`[assembler] 获取容器 release 失败: ${res.status} ${res.statusText} (${repo}@${containerTag})`)
  }
  const release = await res.json()
  const hit = (release.assets || []).find(a => a.name === assetName)
  if (!hit) {
    throw new Error(`[assembler] 容器仓库 ${repo}@${containerTag} 中找不到资产: ${assetName}`)
  }
  const headers = authHeaders({
    'user-agent': 'firefly-resource-assembler',
    accept: 'application/octet-stream'
  })
  const assetRes = await fetch(hit.url, { headers, redirect: 'follow' })
  if (!assetRes.ok) {
    throw new Error(`[assembler] 下载资产失败: ${assetRes.status} (${assetName})`)
  }
  const buf = Buffer.from(await assetRes.arrayBuffer())
  fs.writeFileSync(destPath, buf)
  return destPath
}

function resolveLockedVersion(lockfile, id, sourceKind) {
  if (!lockfile) return null
  if (sourceKind === 'engine') return lockfile.engines?.[id]?.version || null
  return lockfile.resources?.[id]?.version || null
}

/**
 * 解析单个 shared-index 资产的权威元信息（版本、文件名、sha256、size）
 */
function resolveSharedAssetSpec({ index, lockfile, id, sourceKind, platformKeys }) {
  const res = index.resources?.[id]
  if (!res) {
    throw new Error(`[assembler] index.json 中缺失资源定义: ${id}`)
  }
  const lockedVer = resolveLockedVersion(lockfile, id, sourceKind)
  const version = lockedVer || indexLib.resolveLatestVersion(index, id)
  if (!version || !res.versions?.[version]) {
    throw new Error(`[assembler] 资源 ${id} 无法解析目标版本: ${version || '(empty)'}`)
  }
  const verMap = res.versions[version]
  for (const pk of platformKeys) {
    if (verMap[pk]) {
      return { id, version, platformKey: pk, asset: verMap[pk] }
    }
  }
  throw new Error(`[assembler] 资源 ${id}@${version} 不支持目标平台键 [${platformKeys.join(', ')}]`)
}

/**
 * 为本地源码覆盖产物重签目录独占合并清单（供 omni-build-to-desktop 等 DevLocalOverrideAdapter 调用）
 */
function signDevLocalManifest({ targetRoot, dirRel, sourceId, version, gitSha = 'local-dev', extraSources = [] }) {
  const dirPath = path.join(targetRoot, dirRel)
  if (!fs.existsSync(dirPath)) {
    throw new Error(`[assembler] dev-local 签名目标目录不存在: ${dirPath}`)
  }
  const existingManifestPath = getManifestPathForDir(dirPath)
  let inheritedSources = []
  if (fs.existsSync(existingManifestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'))
      if (Array.isArray(prev.sources)) {
        inheritedSources = prev.sources.filter(s => s.id !== sourceId)
      }
    } catch (_) {}
  }
  const sources = [
    { id: sourceId, version, archiveSha256: `dev-local:${gitSha}` },
    ...inheritedSources,
    ...extraSources
  ]
  return writeDirectoryManifest({
    dirPath,
    targetRel: dirRel,
    assemblyMode: 'dev-local',
    sources,
    strictExclusive: true,
    gitSha
  })
}

/**
 * 产品声明式装配主入口
 */
async function assembleProduct(options) {
  const {
    product,
    mode = 'release-locked',
    targetRoot,
    indexPath = DEFAULT_INDEX_PATH,
    lockfilePath,
    presetDir,
    productsDir = PRODUCTS_DIR,
    platform = process.platform,
    arch = process.arch,
    localOverrides = {},
    dryRun = false,
    extractArchive = defaultExtractArchive,
    downloadAsset = defaultDownloadAsset
  } = options || {}

  if (!targetRoot) throw new Error('[assembler] 缺少必填参数 targetRoot')
  if (mode !== 'release-locked' && mode !== 'dev-local') {
    throw new Error(`[assembler] 不支持的装配模式: ${mode}（仅允许 release-locked | dev-local）`)
  }
  if (process.env.NODE_ENV === 'production' && mode === 'dev-local') {
    throw new Error('[assembler] 生产环境 (NODE_ENV=production) 严禁使用 dev-local 装配模式')
  }

  const productManifest = loadProductManifest(product, productsDir)
  const index = indexLib.readIndexFile(indexPath)
  const lockfile = lockfilePath && fs.existsSync(lockfilePath)
    ? JSON.parse(fs.readFileSync(lockfilePath, 'utf8'))
    : null
  const repo = lockfile?.resourcePackage?.repo || 'Leonard-Li777/firefly-resources'
  const containerTag = lockfile?.resourcePackage?.containerTag || index.containerTag || 'resources'
  const platformKeys = resolveTargetPlatformKeys(platform, arch)

  // 按目标相对目录 (dest) 分组：共写目录合并落盘、合并清单
  const destGroups = new Map()
  const bomResources = {}
  const workspaceChecks = []

  for (const entry of productManifest.entries) {
    if (entry.platforms && !entry.platforms.some(p => platformKeys.includes(p))) {
      continue
    }
    if (entry.origin === 'workspace-built') {
      workspaceChecks.push(entry)
      continue
    }
    const resolved = resolveSharedAssetSpec({
      index,
      lockfile,
      id: entry.id,
      sourceKind: entry.sourceKind,
      platformKeys
    })
    bomResources[entry.id] = {
      version: resolved.version,
      source: 'shared',
      dest: entry.dest,
      platformKey: resolved.platformKey,
      asset: resolved.asset
    }
    if (!destGroups.has(entry.dest)) destGroups.set(entry.dest, [])
    destGroups.get(entry.dest).push({ entry, resolved })
  }

  const manifests = {}
  const cleanedExtraFiles = {}
  const skipped = []

  if (dryRun) {
    return {
      product,
      mode,
      targetRoot,
      dryRun: true,
      plannedResources: bomResources,
      workspaceChecks,
      manifests,
      cleanedExtraFiles,
      skipped
    }
  }

  fs.mkdirSync(targetRoot, { recursive: true })
  const effectivePresetDir = presetDir || path.join(targetRoot, '..', 'presetResources')
  fs.mkdirSync(effectivePresetDir, { recursive: true })

  for (const [destRel, groupItems] of destGroups.entries()) {
    const destDir = path.join(targetRoot, destRel)
    const hasOverride = groupItems.some(({ entry }) => Boolean(localOverrides[entry.id]))
    const effectiveMode = hasOverride && mode === 'dev-local' ? 'dev-local' : mode

    const expectedSources = groupItems.map(({ entry, resolved }) => {
      if (localOverrides[entry.id] && mode === 'dev-local') {
        const overrideSpec = localOverrides[entry.id]
        return {
          id: entry.id,
          version: overrideSpec.version || `${resolved.version}-dev`,
          archiveSha256: `dev-local:${overrideSpec.gitSha || 'local'}`
        }
      }
      return {
        id: entry.id,
        version: resolved.version,
        archiveSha256: resolved.asset.sha256
      }
    })

    // 若现有独占清单与目标来源/文件摘要完全一致且无污染文件，跳过解压实现幂等
    const existingCheck = verifyDirectoryManifest(destDir, {
      strictExclusive: true,
      forbidDevLocal: mode === 'release-locked'
    })
    const sameSources =
      existingCheck.ok &&
      existingCheck.manifest.assemblyMode === effectiveMode &&
      JSON.stringify(existingCheck.manifest.sources) === JSON.stringify(expectedSources)

    if (sameSources) {
      manifests[destRel] = existingCheck.manifest
      skipped.push(destRel)
      continue
    }

    // 准备暂存目录合并解压，完成后仅保留预期文件（消除清单外脏文件）
    const stageDir = `${destDir}.stage-${process.pid}`
    fs.rmSync(stageDir, { recursive: true, force: true })
    fs.mkdirSync(stageDir, { recursive: true })

    try {
      for (const { entry, resolved } of groupItems) {
        const overrideSpec = localOverrides[entry.id]
        if (overrideSpec && mode === 'dev-local') {
          if (overrideSpec.files && Array.isArray(overrideSpec.files)) {
            for (const f of overrideSpec.files) {
              const outFile = path.join(stageDir, f.relPath || path.basename(f.src))
              fs.mkdirSync(path.dirname(outFile), { recursive: true })
              fs.copyFileSync(f.src, outFile)
            }
          } else if (overrideSpec.dir) {
            fs.cpSync(overrideSpec.dir, stageDir, { recursive: true, force: true })
          }
          continue
        }

        const archiveName = resolved.asset.name
        const cachePath = path.join(effectivePresetDir, entry.id, archiveName)
        if (fs.existsSync(cachePath)) {
          const cachedSha = sha256FileSync(cachePath)
          if (resolved.asset.sha256 && cachedSha !== resolved.asset.sha256) {
            fs.unlinkSync(cachePath)
          }
        }
        if (!fs.existsSync(cachePath)) {
          await downloadAsset({
            repo,
            containerTag,
            assetName: archiveName,
            destPath: cachePath,
            resourceId: entry.id,
            version: resolved.version
          })
        }
        if (resolved.asset.sha256) {
          const actualSha = sha256FileSync(cachePath)
          if (actualSha !== resolved.asset.sha256) {
            throw new Error(
              `[assembler] 资产校验失败 (${entry.id}@${resolved.version}): 期望 ${resolved.asset.sha256}, 实际 ${actualSha}`
            )
          }
        }
        extractArchive(cachePath, stageDir)
      }

      // 将暂存合并内容替换到正式目录，并删除任何不在预期集合里的旧残留文件
      fs.mkdirSync(destDir, { recursive: true })
      const stagedFiles = collectBusinessFiles(stageDir)
      for (const f of stagedFiles) {
        const dstFile = path.join(destDir, f.relPath)
        fs.mkdirSync(path.dirname(dstFile), { recursive: true })
        fs.copyFileSync(f.abs, dstFile)
      }
      const removed = purgeUntrackedFiles(
        destDir,
        stagedFiles.map(f => f.relPath)
      )
      if (removed.length > 0) cleanedExtraFiles[destRel] = removed

      const gitShaOverride = groupItems
        .map(({ entry }) => localOverrides[entry.id]?.gitSha)
        .find(Boolean)

      manifests[destRel] = writeDirectoryManifest({
        dirPath: destDir,
        targetRel: destRel,
        assemblyMode: effectiveMode,
        sources: expectedSources,
        strictExclusive: true,
        gitSha: gitShaOverride || null
      })
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true })
    }
  }

  // 校验 workspace-built 声明的 requiredFiles 与产品 forbiddenGlobs 黑名单
  const workspaceMissing = []
  for (const wc of workspaceChecks) {
    const destAbs = path.join(targetRoot, wc.dest)
    const missing = (wc.requiredFiles || []).filter(f => !fs.existsSync(path.join(destAbs, f)))
    wc.missingFiles = missing
    if (missing.length > 0 && wc.required) {
      workspaceMissing.push(`${wc.id}: 缺少 ${missing.join(', ')}`)
    }
  }

  const forbiddenHits = []
  if (Array.isArray(productManifest.forbiddenGlobs) && productManifest.forbiddenGlobs.length > 0) {
    const regexes = productManifest.forbiddenGlobs.map(g => {
      const escaped = String(g)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::DOUBLE_STAR::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DOUBLE_STAR::/g, '.*')
      return new RegExp(`^${escaped}$`, 'i')
    })
    for (const f of collectBusinessFiles(targetRoot)) {
      if (regexes.some(re => re.test(f.relPath))) {
        forbiddenHits.push(f.relPath)
      }
    }
    if (forbiddenHits.length > 0) {
      throw new Error(
        `[assembler] 产物命中产品 (${product}) 禁入黑名单 (${forbiddenHits.length} 项): ${forbiddenHits.slice(0, 10).join(', ')}`
      )
    }
  }

  // 生成随包 BOM
  const configsDir = path.join(targetRoot, 'configs')
  fs.mkdirSync(configsDir, { recursive: true })
  const bom = {
    schema: 1,
    product,
    mode,
    platform: `${platform}-${arch}`,
    generatedAt: new Date().toISOString(),
    resources: bomResources
  }
  const bomPath = path.join(configsDir, 'resources.bom.json')
  fs.writeFileSync(bomPath, JSON.stringify(bom, null, 2) + '\n', 'utf8')

  return {
    product,
    mode,
    targetRoot,
    bomPath,
    bom,
    manifests,
    cleanedExtraFiles,
    skipped,
    workspaceChecks,
    workspaceMissing,
    forbiddenHits
  }
}

module.exports = {
  SUPPORTED_PRODUCTS,
  MANIFEST_SCHEMA_VERSION,
  loadProductManifest,
  resolveTopLevelResourceDirs,
  resolveTargetPlatformKeys,
  writeDirectoryManifest,
  verifyDirectoryManifest,
  signDevLocalManifest,
  assembleProduct
}
