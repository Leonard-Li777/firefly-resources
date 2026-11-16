'use strict'

const fs = require('fs')
const https = require('https')
const crypto = require('crypto')

const REGION = 'auto'
const MAX_RETRIES = 3
const RETRY_DELAY = 2000

function hmac(key, string) {
  return crypto.createHmac('sha256', key).update(string).digest()
}

function hash(input) {
  return crypto
    .createHash('sha256')
    .update(input, typeof input === 'string' ? 'utf8' : undefined)
    .digest('hex')
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp)
  const kRegion = hmac(kDate, regionName)
  const kService = hmac(kRegion, serviceName)
  return hmac(kService, 'aws4_request')
}

function getR2Credentials() {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucketName = process.env.R2_BUCKET_NAME
  const accountId = process.env.R2_ACCOUNT_ID
  if (!accessKeyId || !secretAccessKey || !bucketName || !accountId) {
    return null
  }
  return { accessKeyId, secretAccessKey, bucketName, accountId }
}

function isConfigured() {
  return Boolean(getR2Credentials())
}

function r2Request(method, targetKey, options = {}, retryCount = 0) {
  const creds = getR2Credentials()
  if (!creds) throw new Error('Cloudflare R2 环境变量未配置')

  return new Promise((resolve, reject) => {
    const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '')
    const dateStamp = amzDate.substr(0, 8)
    const host = `${creds.bucketName}.${creds.accountId}.r2.cloudflarestorage.com`
    const endpoint = `/${targetKey}`
    const service = 's3'

    const contentHash =
      options.contentHash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

    const canonicalUri = encodeURI(endpoint)
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${contentHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${contentHash}`

    const credentialScope = `${dateStamp}/${REGION}/${service}/aws4_request`
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hash(canonicalRequest)}`

    const signingKey = getSignatureKey(creds.secretAccessKey, dateStamp, REGION, service)
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    const headers = {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': contentHash,
      Authorization: authorizationHeader,
      ...(options.headers || {})
    }

    const reqOptions = {
      hostname: host,
      port: 443,
      path: canonicalUri,
      method: method,
      headers: headers
    }

    const req = https.request(reqOptions, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data })
        } else if (method === 'HEAD' && res.statusCode === 404) {
          resolve({ statusCode: 404, headers: res.headers, body: '' })
        } else {
          const err = new Error(`R2 API 请求失败 (${res.statusCode}): ${data}`)
          err.statusCode = res.statusCode
          if (retryCount < MAX_RETRIES && (res.statusCode >= 500 || res.statusCode === 429)) {
            setTimeout(() => {
              r2Request(method, targetKey, options, retryCount + 1)
                .then(resolve)
                .catch(reject)
            }, RETRY_DELAY)
          } else {
            reject(err)
          }
        }
      })
    })

    req.on('error', err => {
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => {
          r2Request(method, targetKey, options, retryCount + 1)
            .then(resolve)
            .catch(reject)
        }, RETRY_DELAY)
      } else {
        reject(err)
      }
    })

    if (options.bodyStream) {
      options.bodyStream.pipe(req)
    } else if (options.bodyBuffer) {
      req.write(options.bodyBuffer)
      req.end()
    } else {
      req.end()
    }
  })
}

async function getRemoteFileInfo(targetKey) {
  try {
    const res = await r2Request('HEAD', targetKey)
    if (res.statusCode === 200) {
      const size = parseInt(res.headers['content-length'] || '0', 10)
      return { exists: true, size }
    }
    return { exists: false, size: 0 }
  } catch (e) {
    if (e.statusCode === 404) {
      return { exists: false, size: 0 }
    }
    throw e
  }
}

async function uploadAsset({ localPath, name, targetPrefix = 'firefly-resources', force = false }) {
  const targetKey = targetPrefix ? `${targetPrefix}/${name}` : name
  const stat = fs.statSync(localPath)
  const fileSize = stat.size

  if (!force) {
    const remoteInfo = await getRemoteFileInfo(targetKey)
    if (remoteInfo.exists && remoteInfo.size === fileSize) {
      return { skipped: true, targetKey, size: fileSize }
    }
  }

  const contentHash = 'UNSIGNED-PAYLOAD'
  const headers = {
    'Content-Length': fileSize,
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable'
  }

  const fileStream = fs.createReadStream(localPath)
  await r2Request('PUT', targetKey, {
    contentHash,
    headers,
    bodyStream: fileStream
  })

  return { uploaded: true, targetKey, size: fileSize }
}

async function deleteAssets(names, targetPrefix = 'firefly-resources') {
  for (const name of names) {
    const targetKey = targetPrefix ? `${targetPrefix}/${name}` : name
    try {
      await r2Request('DELETE', targetKey)
    } catch (_) {}
  }
}

module.exports = {
  isConfigured,
  getR2Credentials,
  getRemoteFileInfo,
  uploadAsset,
  deleteAssets
}
