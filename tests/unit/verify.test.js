import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { verifyBom } from '../../lib/verify.js'
import { sha256Text } from '../../lib/hash.js'

const FIXTURE_INDEX = path.resolve(__dirname, '../fixtures/index-v1.json')

function writeTempIndex() {
  const text = fs.readFileSync(FIXTURE_INDEX, 'utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-idx-'))
  const p = path.join(dir, 'index.json')
  fs.writeFileSync(p, text, 'utf8')
  return { p, sha: sha256Text(text) }
}

function writeBom(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bom-'))
  const p = path.join(dir, 'bom.json')
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
  return p
}

const ffmpegWinAsset = {
  id: 'ffmpeg',
  version: '7.1',
  asset: 'ffmpeg-7.1-win32-x64.zip',
  sha256: 'a'.repeat(64)
}

afterEach(() => vi.unstubAllGlobals())

describe('verify（发版前置校验）', () => {
  it('一致放行：索引 sha + 全部资产命中', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({ indexSha256: idx.sha, resources: [ffmpegWinAsset] })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.ok).toBe(true)
    expect(result.indexShaOk).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('资产 sha 不符 → 拦截', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({
      indexSha256: idx.sha,
      resources: [{ ...ffmpegWinAsset, sha256: 'f'.repeat(64) }]
    })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('ffmpeg'))).toBe(true)
  })

  it('索引 sha 不符 → 拦截', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({ indexSha256: '0'.repeat(64), resources: [ffmpegWinAsset] })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.indexShaOk).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('upstream 资源跳过索引命中且不拦截', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({
      indexSha256: idx.sha,
      resources: [
        ffmpegWinAsset,
        { id: 'llama.cpp', version: 'b10582', source: 'upstream', asset: 'llama-b10582-bin-win-cpu-x64.zip', sha256: 'c'.repeat(64) }
      ]
    })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.ok).toBe(true)
    const up = result.resources.find(r => r.resourceId === 'llama.cpp')
    expect(up.mode).toBe('upstream')
    expect(up.ok).toBe(true)
  })

  it('BOM 缺 resources 数组 → 拦截', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({ indexSha256: idx.sha })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.ok).toBe(false)
  })

  it('远程仓库模式：mock fetch 拉取 main 索引', async () => {
    const serverText = fs.readFileSync(FIXTURE_INDEX, 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => serverText
    })))
    const bom = writeBom({ indexSha256: sha256Text(serverText), resources: [ffmpegWinAsset] })
    const result = await verifyBom({ bomPath: bom, remoteRepo: 'Leonard-Li777/firefly-resources' })
    expect(result.ok).toBe(true)
    expect(result.indexSha256).toBe(sha256Text(serverText))
  })

  it('schema v1 对象映射：resources/engines 结构放行并识别 upstream', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({
      indexSha256: idx.sha,
      resources: {
        ffmpeg: {
          version: '7.1',
          source: 'shared',
          asset: {
            name: 'ffmpeg-7.1-win32-x64.zip',
            sha256: 'a'.repeat(64),
            size: 1024,
            url: 'https://example.com/ffmpeg-7.1-win32-x64.zip'
          }
        }
      },
      engines: {
        'llama.cpp': { version: 'b10582', source: 'upstream', files: [{ name: 'llama-b10582-bin-win-cpu-x64.zip', size: 1 }] }
      }
    })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.ok).toBe(true)
    expect(result.resources).toHaveLength(2)
    const shared = result.resources.find(r => r.resourceId === 'ffmpeg')
    const eng = result.resources.find(r => r.resourceId === 'llama.cpp')
    expect(shared.mode).toBe('index')
    expect(shared.ok).toBe(true)
    expect(eng.mode).toBe('upstream')
    expect(eng.name).toContain('1 个文件')
  })

  it('schema v1 对象映射：资产 sha 不符 → 拦截', async () => {
    const idx = writeTempIndex()
    const bom = writeBom({
      indexSha256: idx.sha,
      resources: {
        ffmpeg: {
          version: '7.1',
          source: 'shared',
          asset: { name: 'ffmpeg-7.1-win32-x64.zip', sha256: 'f'.repeat(64) }
        }
      }
    })
    const result = await verifyBom({ bomPath: bom, indexPath: idx.p })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('ffmpeg'))).toBe(true)
  })
})