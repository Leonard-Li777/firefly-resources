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
  ghClient
}) {
  const gh = ghClient || defaultGh
  assertManifestShape(manifest)

  const index = fs.existsSync(indexPath) ? indexLib.readIndexFile(indexPath) : indexLib.emptyIndex(tag)
  // 远端现有资产名快照（dryRun 或 tag 不存在时为空）
  const existing = dryRun ? [] : await gh.listAssetNames(repo, tag)
  if (!dryRun) gh.ensureTag(repo, tag)

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
      const localPath = def.assets[platformKey]
      const name = naming.assetNameFor({
        resourceId,
        version: def.version,
        platformKey,
        ext: def.ext
      })
      if (existing.includes(name)) {
        summary.skipped.push({ resourceId, name })
        continue
      }
      if (!fs.existsSync(localPath)) {
        summary.missing.push({ resourceId, name, localPath })
        continue
      }
      const sha256 = await hashLib.sha256File(localPath)
      const size = fs.statSync(localPath).size
      try {
        indexLib.upsertAsset(index, { resourceId, version: def.version, platformKey, name, sha256, size })
      } catch (e) {
        summary.errors.push({ resourceId, name, message: e.message })
        continue
      }
      if (!dryRun) {
        gh.uploadAsset({ repo, tag, localPath, name })
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

  indexLib.writeIndexFile(indexPath, index)
  return { ...summary, pruned: prunedAll, indexUpdatedAt: index.updatedAt }
}

module.exports = { publishFromManifest, readSourceInfo, assertManifestShape }