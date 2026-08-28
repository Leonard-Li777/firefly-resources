'use strict'

/**
 * 轻量网络下载（零运行时依赖）
 * 优先使用系统 curl（自动继承 HTTP(S)_PROXY / ALL_PROXY 环境变量，跟随重定向）；
 * 无 curl 时回退 Node 原生 https。
 */

const https = require('https')
const fs = require('fs')
const { spawnSync } = require('child_process')

/**
 * 探测可用的 curl（Windows 10+ / macOS / Linux 均预装或常见）
 * @returns {boolean}
 */
function hasCurl() {
  const res = spawnSync('curl', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  return res.status === 0
}

/**
 * 下载文件
 * @param {string} url
 * @param {string} destPath
 * @param {{proxy?: string}} [opts]
 * @returns {Promise<string>} destPath
 */
function downloadFile(url, destPath, opts = {}) {
  // curl 优先：自动继承 HTTP(S)_PROXY/ALL_PROXY，跟随重定向（本地网络需代理）
  if (hasCurl()) {
    return new Promise((resolve, reject) => {
      const args = ['-L', '--fail', '--silent', '--show-error', '--retry', '3', '-o', destPath, url]
      if (opts.proxy) args.push('--proxy', opts.proxy)
      const res = spawnSync('curl', args, { encoding: 'utf8', stdio: 'pipe' })
      if (res.status === 0) resolve(destPath)
      else reject(new Error(`curl 下载失败 ${res.status || ''}: ${url}（${res.stderr.trim()}）`))
    })
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'firefly-resource-publisher' } }, res => {
      const { statusCode, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        resolve(downloadFile(new URL(headers.location, url).toString(), destPath, opts))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        reject(new Error(`下载失败 ${statusCode}: ${url}`))
        return
      }
      const out = fs.createWriteStream(destPath)
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve(destPath)))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(180000, () => req.destroy(new Error('下载超时')))
  })
}

/**
 * 拉取文本（curl 优先）
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchText(url) {
  if (hasCurl()) {
    const args = ['-L', '--fail', '--silent', '--show-error', '--retry', '2', url]
    const res = spawnSync('curl', args, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
    if (res.status === 0) return res.stdout
    return null
  }
  return fetchTextNode(url)
}

/**
 * Node 原生实现（见 lib/resource-consumer 的 httpGetText 等价物）
 * @param {string} url
 * @param {number} [redirects]
 * @returns {Promise<string|null>}
 */
function fetchTextNode(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'firefly-resource-publisher' } }, res => {
      const { statusCode, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        if (redirects >= 5) return resolve(null)
        resolve(fetchTextNode(new URL(headers.location, url).toString(), redirects + 1))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => (body += c))
      res.on('end', () => resolve(body))
    })
    req.on('error', () => resolve(null))
    req.setTimeout(60000, () => req.destroy())
  })
}

module.exports = { downloadFile, fetchText, hasCurl }