'use strict'

const fs = require('fs')
const path = require('path')

const indexLib = require('./index')
const naming = require('./naming')
const hashLib = require('./hash')
const defaultGh = require('./gh')

/**
 * 发布管线核心逻辑（迁移/手工上传 → 更新 index）
 * 与 CLI 分离以便单元测试；网络/gh 由调用方 mock。
 */

/**
 * 读取某资源的上游规则（sources/<id>.json）
 * @param {string} sourcesRoot sources 目录
 * @param {string} resourceId 资源 ID
 * @returns {{type: string}|null}
 */
function readSourceInfo(sourcesRoot, resourceId) {
  const p = path.join(sourcesRoot, `${resourceId}.json`)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/**
 * 校验 manifest 结构
 * @param {object} manifest
 */
function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.resources) {
    throw new Error('[manifest] 缺少 resources 字段')
  }
  for (const rid of Object.keys(manifest.resources)) {
    const def = manifest.resources[rid]
    if (!def.version) throw new Error(`[manifest] ${rid} 缺少 version`)
    if (!def.ext) throw new Error(`[manifest] ${rid} 缺少 ext（压缩格式）`)
    if (!def.assets || typeof def.assets !== 'object') {
      throw new Error(`[manifest] ${rid} 缺少 assets（platformKey → 本地路径）`)
    }
    for (const key of Object.keys(def.assets)) {
      if (!naming.isValidPlatformKey(key)) {
        throw new Error(`[manifest] ${rid} 平台键非法：${key}`)
      }
    }
  }
}

/**
 * 发布入口
 * @param {object} opts
 * @param {object} opts.manifest 发布清单（resources: id → {version, ext, assets{platformKey: localPath}}）
 * @param {string} [opts.sourcesRoot='./sources'] sources 目录
 * @param {string} opts.repo 完整仓库名（owner/repo）
 * @param {string} [opts.tag='resources'] 容器 tag
 * @param {boolean} [opts.dryRun=false] 只算不传
 * @param {boolean} [opts.keep=0] 保留版本数（0=不裁剪）
 * @param {object} [opts.ghClient] gh 客户端依赖注入（测试用；缺省默认 gh CLI 封装）
 * @param {Function} [opts.fetchLocalPath] 当 assets 中某平台本地路径缺失且 sources 声明
 *   upstream.kind==='online' 时调用：({resourceId, source, platformKey, version, ext}) => Promise<string|null>，
 *   返回可用的本地归档路径（如从线上源下载后重打包），null/抛错则计入 missing/errors。
 * @returns {Promise<object>} 摘要
 */
async function publishFromManifest({
  manifest,
  sourcesRoot = path.resolve(__dirname, '../sources'),
  repo = 'Leonard-Li777/firefly-resources',
  tag = 'resources',
  dryRun = false,
  keep = 0,
  indexPath = path.resolve(__dirname, '../index.json'),
  ghClient,
  fetchLocalPath
}) {
  const gh = ghClient || defaultGh
  assertManifestShape(manifest)

  const index = fs.existsSync(indexPath) ? indexLib.readIndexFile(indexPath) : indexLib.emptyIndex(tag)
  // 远端现有资产名快照（dryRun 或 tag 不存在时为空）
  const existing = dryRun ? [] : await gh.listAssetNames(repo, tag)
  if (!dryRun) gh.ensureTag(repo, tag)

  const force = !!opts.force
  const summary = { uploaded: [], skipped: [], missing: [], errors: [] }
  const prunedAll = []

  for (const resourceId of Object.keys(manifest.resources)) {
    const def = manifest.resources[resourceId]
    const source = readSourceInfo(sourcesRoot, resourceId)
    // 类型以 sources 定义为准，缺省 tool
    if (index.resources[resourceId]) {
      if (source && source.type) index.resources[resourceId].type = source.type
    } else {
      index.resources[resourceId] = {
        type: source && source.type ? source.type : 'tool',
        latest: def.version,
        versions: {}
      }
    }

    for (const platformKey of Object.keys(def.assets)) {
      const raw = def.assets[platformKey]
      // assets 值两种形态：字符串路径 或 { path, ext }（per-platform 扩展名，如 llama-model-download 混合 zip/tar.gz）
      const ext = raw && typeof raw === 'object' ? raw.ext || def.ext : def.ext
      const localPath = raw && typeof raw === 'object' ? raw.path : raw
      const name = naming.assetNameFor({
        resourceId,
        version: def.version,
        platformKey,
        ext
      })
      if (existing.includes(name) && !force) {
        // 同名资产已在远端：非 force 模式下幂等跳过；若本地文件仍存在则同步补写索引（覆盖中断后 index 缺失的场景）
        if (localPath && fs.existsSync(localPath)) {
          const sh = await hashLib.sha256File(localPath)
          const sz = fs.statSync(localPath).size
          try {
            indexLib.upsertAsset(index, { resourceId, version: def.version, platformKey, name, sha256: sh, size: sz }, force)
          } catch (e) {
            summary.errors.push({ resourceId, name, message: e.message })
          }
        }
        summary.skipped.push({ resourceId, name })
        continue
      }
      // 本地缺失且声明了在线来源 → 自动下载/重打包后再发布（--offline 场景由 CLI 不注入回调规避）
      let local = localPath
      if ((!local || !fs.existsSync(local)) && fetchLocalPath && source && source.upstream && source.upstream.kind === 'online') {
        try {
          const fetched = await fetchLocalPath({
            resourceId,
            source,
            platformKey,
            version: def.version,
            ext
          })
          if (fetched) local = fetched
        } catch (e) {
          summary.errors.push({ resourceId, name, message: `在线获取失败：${e.message}` })
          continue
        }
      }
      if (!fs.existsSync(local)) {
        summary.missing.push({ resourceId, name, localPath: local })
        continue
      }
      const sha256 = await hashLib.sha256File(local)
      const size = fs.statSync(local).size
      try {
        indexLib.upsertAsset(index, { resourceId, version: def.version, platformKey, name, sha256, size }, force)
      } catch (e) {
        summary.errors.push({ resourceId, name, message: e.message })
        continue
      }
      if (!dryRun) {
        if (existing.includes(name) && force) {
          try {
            gh.deleteAssets(repo, tag, [name])
          } catch (delErr) {
            // 忽略删除失败直接尝试上传覆盖
          }
        }
        gh.uploadAsset({ repo, tag, localPath: local, name })
      }
      summary.uploaded.push({ resourceId, name, sha256: sha256.slice(0, 12), size })
    }

    if (def.latest) {
      indexLib.setLatest(index, resourceId, def.latest === 'latest' ? 'latest' : def.version)
    } else {
      indexLib.setLatest(index, resourceId, def.version)
    }

    if (keep > 0) {
      const prunable = indexLib.collectPrunableVersions(index, resourceId, keep)
      if (prunable.versions.length > 0) {
        prunedAll.push({ resourceId, versions: prunable.versions, assetNames: prunable.assetNames })
        indexLib.removeVersions(index, resourceId, prunable.versions)
        if (!dryRun) {
          gh.deleteAssets(repo, tag, prunable.assetNames)
        }
      }
    }
  }

  if (!dryRun) indexLib.writeIndexFile(indexPath, index)
  return { ...summary, pruned: prunedAll, indexUpdatedAt: index.updatedAt }
}

module.exports = { publishFromManifest, readSourceInfo, assertManifestShape }