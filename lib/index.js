'use strict'

const fs = require('fs')

/**
 * index.json（schema v1）读写与不可变更新协议
 *
 * 顶层：{ schema, containerTag, updatedAt, resources }
 * resources[resourceId] = { type, latest, versions{ <version>: { <platformKey>: { name, sha256, size } } } }
 * latest 允许具体版本号或字面量 'latest'。
 */

const SCHEMA = 1

/**
 * 生成空索引
 * @param {string} containerTag 容器 tag（默认 'resources'）
 * @returns {object}
 */
function emptyIndex(containerTag = 'resources') {
  return {
    schema: SCHEMA,
    containerTag,
    updatedAt: new Date().toISOString(),
    resources: {}
  }
}

/**
 * 读取索引文件
 * @param {string} indexPath 文件路径
 * @returns {object}
 */
function readIndexFile(indexPath) {
  const raw = fs.readFileSync(indexPath, 'utf8')
  return JSON.parse(raw)
}

/**
 * 写索引文件
 * @param {string} indexPath 文件路径
 * @param {object} index 索引对象
 */
function writeIndexFile(indexPath, index) {
  index.updatedAt = new Date().toISOString()
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8')
}

/**
 * 幂等写入一个资产条目。同名资产已存在且 sha 不同：若 force=true 则覆盖更新，否则抛错（不可变策略）。
 * @param {object} index 索引
 * @param {{resourceId: string, version: string, platformKey: string, name: string, sha256: string, size: number}} asset
 * @param {boolean} [force=false] 是否强制覆盖已存在条目
 * @returns {{skipped: boolean}} skipped=true 表示已有完全相同的条目
 */
function upsertAsset(index, asset, force = false) {
  const { resourceId, version, platformKey, name, sha256, size } = asset
  const res = (index.resources[resourceId] = index.resources[resourceId] || {
    type: 'tool',
    latest: version,
    versions: {}
  })
  const ver = (res.versions[version] = res.versions[version] || {})
  const existing = ver[platformKey]
  if (existing) {
    if (existing.name === name && existing.sha256 === sha256) {
      return { skipped: true }
    }
    if (!force) {
      throw new Error(
        `[index] 同名资产不可变：${resourceId}/${version}/${platformKey} 已被占用（${existing.name !== name ? '资产名不同' : 'sha256 不同'}）`
      )
    }
  }
  ver[platformKey] = { name, sha256, size }
  return { skipped: false }
}

/**
 * 设置/更新某资源的 latest 标记
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @param {string} value 具体版本号或字面量 'latest'
 */
function setLatest(index, resourceId, value) {
  if (!index.resources[resourceId]) {
    index.resources[resourceId] = { type: 'tool', latest: value, versions: {} }
    return
  }
  index.resources[resourceId].latest = value
}

/**
 * 数值优先的版本比较器（点分数字比较，容忍字母尾缀如 -beta / b10582）
 * @param {string} a
 * @param {string} b
 * @returns {number} a>b: >0, a<b: <0, 相等: 0
 */
function parseVersionParts(s) {
  const m = String(s).match(/^v?(\d+(?:\.\d+)*)(.*)$/i)
  if (!m) return null
  return { nums: m[1].split('.').map(Number), tail: m[2].toLowerCase() }
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  if (!pa || !pb) return String(a).localeCompare(String(b))
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] || 0
    const nb = pb.nums[i] || 0
    if (na !== nb) return na - nb
  }
  // 数字段相同 → 字母尾缀字典序（无尾缀视为更新）
  if (pa.tail !== pb.tail) {
    if (!pa.tail) return 1
    if (!pb.tail) return -1
    return pa.tail < pb.tail ? -1 : 1
  }
  return 0
}

/**
 * 版本列表按升序排序
 * @param {string[]} versions
 * @returns {string[]}
 */
function sortVersions(versions) {
  return [...versions].sort(compareVersions)
}

/**
 * 解析某资源的"当前版本"：latest 为具体版本 → 返回之；为 'latest' → 返回最大版本
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @returns {string|null}
 */
function resolveLatestVersion(index, resourceId) {
  const res = index.resources[resourceId]
  if (!res) return null
  const keys = Object.keys(res.versions || {})
  if (keys.length === 0) return null
  if (res.latest && res.latest !== 'latest') return res.latest
  return sortVersions(keys)[keys.length - 1]
}

/**
 * 解析某资源在指定平台键下的当前资产
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @param {string} platformKey 平台键（'default' 等）
 * @returns {{version: string, asset: object}|null}
 */
function resolveLatestAsset(index, resourceId, platformKey) {
  const version = resolveLatestVersion(index, resourceId)
  if (!version) return null
  const asset = index.resources[resourceId].versions[version]?.[platformKey]
  if (!asset) return null
  return { version, asset }
}

/**
 * 按资源库存里的某版本键查询资产是否存在
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @param {string} assetName 资产名
 * @param {string} sha256 期望 sha256
 * @returns {boolean}
 */
function hasAssetWithSha(index, resourceId, assetName, sha256) {
  const res = index.resources[resourceId]
  if (!res) return false
  for (const version of Object.keys(res.versions)) {
    const ver = res.versions[version]
    for (const platformKey of Object.keys(ver)) {
      const asset = ver[platformKey]
      if (asset.name === assetName && sha256 && asset.sha256 === sha256) return true
    }
  }
  return false
}

/**
 * 历史版本裁剪：返回应删除的版本列表（不直接改动资产）
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @param {number} keep 保留版本数
 * @returns {{versions: string[], assetNames: string[]}}
 */
function collectPrunableVersions(index, resourceId, keep) {
  const res = index.resources[resourceId]
  if (!res) return { versions: [], assetNames: [] }
  const keys = sortVersions(Object.keys(res.versions))
  if (keys.length <= keep) return { versions: [], assetNames: [] }
  const remove = keys.slice(0, keys.length - keep)
  const assetNames = []
  for (const v of remove) {
    const ver = res.versions[v]
    for (const platformKey of Object.keys(ver)) assetNames.push(ver[platformKey].name)
  }
  return { versions: remove, assetNames }
}

/**
 * 从索引中移除版本条目（资产删除由调用方执行）
 * @param {object} index 索引
 * @param {string} resourceId 资源 ID
 * @param {string[]} versions 待删版本
 */
function removeVersions(index, resourceId, versions) {
  const res = index.resources[resourceId]
  if (!res) return
  for (const v of versions) delete res.versions[v]
  if (Object.keys(res.versions).length === 0) {
    delete index.resources[resourceId]
  }
}

module.exports = {
  SCHEMA,
  emptyIndex,
  readIndexFile,
  writeIndexFile,
  upsertAsset,
  setLatest,
  compareVersions,
  sortVersions,
  resolveLatestVersion,
  resolveLatestAsset,
  hasAssetWithSha,
  collectPrunableVersions,
  removeVersions
}