'use strict'

const fs = require('fs')
const crypto = require('crypto')

/**
 * 计算文件的 sha256
 * @param {string} filePath 文件路径
 * @returns {Promise<string>} 小写十六进制 sha256
 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * 计算字符串内容的 sha256（用于索引文件校验）
 * @param {string} content 文本内容
 * @returns {string}
 */
function sha256Text(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

module.exports = { sha256File, sha256Text }