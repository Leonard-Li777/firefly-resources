'use strict'

/**
 * 资产命名与平台词表（schema 协议常量）
 */

/** 平台-架构词表（7 项） */
const PLATFORM_ARCH = [
  'win32-x64',
  'win32-arm64',
  'darwin-x64',
  'darwin-arm64',
  'darwin-universal',
  'linux-x64',
  'linux-arm64'
]

/** 无平台语义资源的键名 */
const DEFAULT_KEY = 'default'

/**
 * 判断是否为合法平台键（含 default）
 * @param {string} key 平台键
 * @returns {boolean}
 */
function isValidPlatformKey(key) {
  return PLATFORM_ARCH.includes(key) || key === DEFAULT_KEY
}

/**
 * 由 Node 的 os.platform()/os.arch() 推断平台键
 * @param {string} platform os.platform()
 * @param {string} arch os.arch()
 * @returns {string|null}
 */
function inferPlatformKey(platform, arch) {
  const p = String(platform || '').toLowerCase()
  const a = String(arch || '').toLowerCase()
  if (p === 'win32') {
    if (a === 'x64' || a === 'arm64') return `win32-${a}`
    return null
  }
  if (p === 'darwin') {
    if (a === 'x64') return 'darwin-x64'
    if (a === 'arm64') return 'darwin-arm64'
    return 'darwin-universal'
  }
  if (p === 'linux') {
    if (a === 'x64' || a === 'arm64') return `linux-${a}`
    return null
  }
  return null
}

/**
 * 生成资产名
 * 有平台语义：{resourceId}-{version}-{platform}-{arch}.{ext}
 * 无平台语义：{resourceId}-{version}.{ext}
 * @param {{resourceId: string, version: string, platformKey: string, ext: string}} input
 * @returns {string}
 */
function assetNameFor({ resourceId, version, platformKey, ext }) {
  const base = `${resourceId}-${version}`
  const suffix = platformKey === DEFAULT_KEY ? '' : `-${platformKey}`
  return `${base}${suffix}.${ext}`
}

module.exports = {
  PLATFORM_ARCH,
  DEFAULT_KEY,
  isValidPlatformKey,
  inferPlatformKey,
  assetNameFor
}