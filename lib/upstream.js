'use strict'

/**
 * ffmpeg / ffprobe 在线更新来源（BtbN/FFmpeg-Builds）
 * lib/upstream.js
 *
 * BtbN/FFmpeg-Builds 的 `latest` tag 为滚动 master 构建，覆盖 win32-x64/arm64、
 * linux-x64/arm64（不提供 macOS）。一份归档同时含 ffmpeg 与 ffprobe 单二进制。
 *
 * 流程：
 *   1. 取 latest release 的 published_at → 版本号 master-YYYYMMDD（滚动内容不可变名，
 *      用构建日期做快照版本，避免同名资产 sha 冲突破坏不可变协议）；
 *   2. 按平台键下载对应归档（zip 或 tar.xz）；
 *   3. 解压提取 bin/ 下的单二进制；
 *   4. 重打包为规范命名 zip 供 publish 管线消费。
 *
 * macOS 不提供在线源时返回 null（发布侧回退本地既有资产），预留 evermeet 通道。
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { downloadFile, fetchText } = require('./fetch')

const BTBN_RELEASES_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'
const BTBN_DOWNLOAD_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'

/** BtbN 平台键 → 归档资产名与压缩格式 */
const BTBN_TEMPLATES = {
  'win32-x64': { name: 'ffmpeg-master-latest-win64-gpl.zip', kind: 'zip' },
  'win32-arm64': { name: 'ffmpeg-master-latest-winarm64-gpl.zip', kind: 'zip' },
  'linux-x64': { name: 'ffmpeg-master-latest-linux64-gpl.tar.xz', kind: 'tar.xz' },
  'linux-arm64': { name: 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz', kind: 'tar.xz' }
}

/**
 * 取 BtbN 最新滚动构建的版本快照号（master-YYYYMMDD）
 * @param {{fetchText?: (url: string) => Promise<string|null>}} [opts] 测试注入
 * @returns {Promise<string>}
 */
async function getBtbNMasterVersion(opts = {}) {
  const f = opts.fetchText || fetchText
  const body = await f(BTBN_RELEASES_API)
  if (!body) throw new Error('[upstream] 无法查询 BtbN latest release')
  const rel = JSON.parse(body)
  const day = (rel.published_at || new Date().toISOString()).slice(0, 10).replace(/-/g, '')
  return `master-${day}`
}

/**
 * BtbN 是否支持该平台键
 * @param {string} platformKey
 * @returns {boolean}
 */
function btbNSupports(platformKey) {
  return Object.prototype.hasOwnProperty.call(BTBN_TEMPLATES, platformKey)
}

/**
 * 下载归档 → 解压 → 提取单二进制 → 重打包 zip。
 * @param {object} opts
 * @param {string} opts.resourceId 'ffmpeg' | 'ffprobe'
 * @param {string} opts.version 版本号（来自 getBtbNMasterVersion）
 * @param {string} opts.platformKey 平台键
 * @param {string} opts.cacheDir 工作目录（临时）
 * @param {{downloadFile?: Function, fetchText?: Function}} [dep] 测试注入
 * @returns {Promise<string|null>} 规范命名的 zip 路径；平台不支持返回 null
 */
async function fetchBtbNSingle({ resourceId, version, platformKey, cacheDir }, dep = {}) {
  const tpl = BTBN_TEMPLATES[platformKey]
  if (!tpl) return null
  if (resourceId !== 'ffmpeg' && resourceId !== 'ffprobe') return null

  const dl = dep.downloadFile || downloadFile
  const exeName = resourceId === 'ffmpeg' ? 'ffmpeg' : 'ffprobe'
  const winExeExt = platformKey.startsWith('win32') ? '.exe' : ''
  const fullExe = exeName + winExeExt

  // 共享缓存目录设计：raw/ 存上游归档（ffmpeg/ffprobe 复用同一归档），extract-<platformKey>/ 解压（两资源复用）
  const rawDir = path.join(cacheDir, 'raw')
  fs.mkdirSync(rawDir, { recursive: true })
  const archivePath = path.join(rawDir, tpl.name)
  const extractDir = path.join(cacheDir, `extract-${platformKey}`)

  if (!fs.existsSync(archivePath)) {
    await dl(`${BTBN_DOWNLOAD_BASE}/${tpl.name}`, archivePath)
  }

  // 解压（zip 与 tar.xz 均可用系统 tar 处理；目录已存在则复用，避免重复解压百 MB 归档）
  if (!fs.existsSync(extractDir) || !findExecutable(extractDir, exeName, winExeExt)) {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true })
    fs.mkdirSync(extractDir, { recursive: true })
    const flags = tpl.kind === 'zip' ? ['-xf', archivePath] : ['-xJf', archivePath]
    const res = spawnSync('tar', [...flags, '-C', extractDir], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`[upstream] 解压 ${tpl.name} 失败：${res.stderr || res.status}`)
  }

  const exePath = findExecutable(extractDir, exeName, winExeExt)
  if (!exePath) throw new Error(`[upstream] 归档中未找到 ${fullExe}`)

  const outName = `${resourceId}-${version}-${platformKey}.zip`
  const outPath = path.join(cacheDir, outName)
  repackZipSingle(exePath, outPath, fullExe)
  return outPath
}

/**
 * 在解压树中查找目标二进制（BtbN 位于 bin/)
 * @param {string} root 解压根
 * @param {string} exeName 无扩展名二进制名
 * @param {string} ext 平台扩展名
 * @returns {string|null}
 */
function findExecutable(root, exeName, ext) {
  const direct = path.join(root, 'bin', exeName + ext)
  if (fs.existsSync(direct)) return direct
  const scan = dir => {
    if (!fs.existsSync(dir)) return null
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item)
      if (!fs.statSync(full).isDirectory()) continue
      const cand = path.join(full, 'bin', exeName + ext)
      if (fs.existsSync(cand)) return cand
      const nested = scan(full)
      if (nested) return nested
    }
    return null
  }
  return scan(root)
}

/**
 * 将单个可执行文件重打包为 zip（bsdtar，win/mac/linux 均内置）
 * @param {string} exePath
 * @param {string} outZip
 * @param {string} exeName 压缩包内文件名
 */
function repackZipSingle(exePath, outZip, exeName) {
  const tmp = path.dirname(outZip)
  const staging = path.join(tmp, 'staging', path.basename(outZip))
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    fs.copyFileSync(exePath, path.join(staging, exeName))
    const res = spawnSync('tar', ['-a', '-cf', outZip, '-C', staging, exeName], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`[upstream] 打包 ${outZip} 失败：${res.stderr || res.status}`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

module.exports = {
  BTBN_TEMPLATES,
  getBtbNMasterVersion,
  btbNSupports,
  fetchBtbNSingle,
  findExecutable,
  repackZipSingle
}