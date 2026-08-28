import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { publishFromManifest } from '../../lib/publish.js'

function makeGhStub({ existing = [] } = {}) {
  return {
    listAssetNames: vi.fn(async () => [...existing]),
    ensureTag: vi.fn(),
    uploadAsset: vi.fn(),
    deleteAssets: vi.fn()
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFakeAsset(dir, name, content = 'fake-binary-content') {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

describe('publishFromManifest（发布管线）', () => {
  it('上传新资产、跳过已存在资产、记录本地缺失，并更新索引', async () => {
    const dir = makeTempDir('publish-')
    const indexPath = path.join(dir, 'index.json')
    fs.writeFileSync(indexPath, JSON.stringify({ schema: 1, containerTag: 'resources', updatedAt: '', resources: {} }), 'utf8')
    const sourcesRoot = path.join(dir, 'sources')
    fs.mkdirSync(sourcesRoot)
    fs.writeFileSync(path.join(sourcesRoot, 'fastfetch.json'), JSON.stringify({ resourceId: 'fastfetch', type: 'tool' }), 'utf8')

    const winLocal = writeFakeAsset(dir, 'ffmpeg-win.zip', 'win-bin')
    const macLocal = writeFakeAsset(dir, 'ffmpeg-mac.zip', 'mac-bin')
    const gh = makeGhStub({ existing: ['ffmpeg-7.1-win32-x64.zip'] })

    const summary = await publishFromManifest({
      manifest: {
        resources: {
          ffmpeg: {
            version: '7.1',
            ext: 'zip',
            assets: {
              'win32-x64': winLocal, // 已存在 → 跳过
              'darwin-arm64': macLocal, // → 上传
              'linux-x64': path.join(dir, 'missing-linux.zip') // → 缺失
            }
          },
          fastfetch: {
            version: '2.31.0',
            ext: 'zip',
            assets: { 'win32-x64': writeFakeAsset(dir, 'fastfetch.zip', 'ff-bin') }
          }
        }
      },
      sourcesRoot,
      indexPath,
      repo: 'Leonard-Li777/firefly-resources',
      tag: 'resources',
      dryRun: false,
      keep: 0,
      ghClient: gh
    })

    expect(summary.uploaded).toHaveLength(2) // ffmpeg-darwin + fastfetch-win32
    expect(summary.uploaded.map(u => u.name)).toContain('ffmpeg-7.1-darwin-arm64.zip')
    expect(summary.skipped.map(s => s.name)).toContain('ffmpeg-7.1-win32-x64.zip')
    expect(summary.missing).toHaveLength(1)
    expect(gh.ensureTag).toHaveBeenCalled()
    expect(gh.uploadAsset).toHaveBeenCalledTimes(2)

    // 索引落盘校验
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    const ffmpegMac = index.resources.ffmpeg.versions['7.1']['darwin-arm64']
    expect(ffmpegMac.name).toBe('ffmpeg-7.1-darwin-arm64.zip')
    expect(ffmpegMac.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(index.resources.fastfetch.versions['2.31.0']['win32-x64'].name).toBe('fastfetch-2.31.0-win32-x64.zip')
    expect(index.resources.ffmpeg.latest).toBe('7.1')
  })

  it('dry-run 不上传，但索引与摘要正常产出', async () => {
    const dir = makeTempDir('publish-dry-')
    const indexPath = path.join(dir, 'index.json')
    fs.writeFileSync(indexPath, JSON.stringify({ schema: 1, containerTag: 'resources', updatedAt: '', resources: {} }), 'utf8')
    const local = writeFakeAsset(dir, 'geo.zip', 'geo-data')
    const gh = makeGhStub()

    const summary = await publishFromManifest({
      manifest: {
        resources: {
          geo: { version: '2026.4', ext: 'tar.gz', assets: { default: local } }
        }
      },
      indexPath,
      dryRun: true,
      keep: 0,
      ghClient: gh
    })

    expect(summary.uploaded).toHaveLength(1)
    expect(gh.ensureTag).not.toHaveBeenCalled()
    expect(gh.uploadAsset).not.toHaveBeenCalled()
    expect(summary.uploaded[0].name).toBe('geo-2026.4.tar.gz')
  })

  it('keep 裁剪历史版本并删除远端资产', async () => {
    const dir = makeTempDir('publish-prune-')
    const indexPath = path.join(dir, 'index.json')
    const existing = {
      schema: 1,
      containerTag: 'resources',
      updatedAt: '',
      resources: {
        poppler: {
          type: 'tool',
          latest: '2.1',
          versions: {
            '1.0': { default: { name: 'poppler-1.0.zip', sha256: 'a'.repeat(64), size: 1 } },
            '2.0': { default: { name: 'poppler-2.0.zip', sha256: 'b'.repeat(64), size: 1 } },
            '2.1': { default: { name: 'poppler-2.1.zip', sha256: 'c'.repeat(64), size: 1 } }
          }
        }
      }
    }
    fs.writeFileSync(indexPath, JSON.stringify(existing), 'utf8')
    const gh = makeGhStub({ existing: ['poppler-1.0.zip', 'poppler-2.0.zip', 'poppler-2.1.zip'] })

    const summary = await publishFromManifest({
      manifest: {
        resources: {
          poppler: {
            version: '2.1',
            ext: 'zip',
            assets: { default: writeFakeAsset(dir, 'poppler-2.1.zip', 'poppler-bin') }
          }
        }
      },
      indexPath,
      dryRun: false,
      keep: 2,
      ghClient: gh
    })

    expect(summary.pruned).toHaveLength(1)
    expect(summary.pruned[0].assetNames).toEqual(['poppler-1.0.zip'])
    expect(gh.deleteAssets).toHaveBeenCalledWith('Leonard-Li777/firefly-resources', 'resources', ['poppler-1.0.zip'])
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    expect(Object.keys(index.resources.poppler.versions)).toEqual(['2.0', '2.1'])
  })

  it('manifest 结构非法抛出', async () => {
    await expect(
      publishFromManifest({ manifest: { resources: { bad: { ext: 'zip', assets: { default: 'x' } } } }, ghClient: makeGhStub() })
    ).rejects.toThrow(/version/)
  })

  it('本地缺失且 sources 声明在线来源时，经 fetchLocalPath 自动获取后上传', async () => {
    const dir = makeTempDir('publish-online-')
    const indexPath = path.join(dir, 'index.json')
    fs.writeFileSync(indexPath, JSON.stringify({ schema: 1, containerTag: 'resources', updatedAt: '', resources: {} }), 'utf8')
    const sourcesRoot = path.join(dir, 'sources')
    fs.mkdirSync(sourcesRoot)
    fs.writeFileSync(
      path.join(sourcesRoot, 'ffmpeg.json'),
      JSON.stringify({ resourceId: 'ffmpeg', type: 'tool', upstream: { kind: 'online', provider: 'BtbN/FFmpeg-Builds' } }),
      'utf8'
    )
    // fetchLocalPath 返回临时下载产物（模拟 online 下载 + 重打包）
    const fetched = writeFakeAsset(dir, 'fetched-ffmpeg.zip', 'online-bin')
    const fetchLocalPath = vi.fn(async () => fetched)
    const gh = makeGhStub()

    const summary = await publishFromManifest({
      manifest: {
        resources: {
          ffmpeg: { version: 'master-20260827', ext: 'zip', assets: { 'win32-x64': null } }
        }
      },
      sourcesRoot,
      indexPath,
      dryRun: false,
      keep: 0,
      ghClient: gh,
      fetchLocalPath
    })

    expect(fetchLocalPath).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'ffmpeg', platformKey: 'win32-x64' }))
    expect(summary.uploaded.map(u => u.name)).toContain('ffmpeg-master-20260827-win32-x64.zip')
    expect(summary.missing).toHaveLength(0)
  })

  it('在线获取抛错时计入 errors 而非崩溃', async () => {
    const dir = makeTempDir('publish-online-err-')
    const indexPath = path.join(dir, 'index.json')
    fs.writeFileSync(indexPath, JSON.stringify({ schema: 1, containerTag: 'resources', updatedAt: '', resources: {} }), 'utf8')
    const sourcesRoot = path.join(dir, 'sources')
    fs.mkdirSync(sourcesRoot)
    fs.writeFileSync(
      path.join(sourcesRoot, 'ffmpeg.json'),
      JSON.stringify({ resourceId: 'ffmpeg', type: 'tool', upstream: { kind: 'online', provider: 'BtbN/FFmpeg-Builds' } }),
      'utf8'
    )
    const fetchLocalPath = vi.fn(async () => {
      throw new Error('网络抖动')
    })
    const gh = makeGhStub()

    const summary = await publishFromManifest({
      manifest: {
        resources: {
          ffmpeg: { version: 'master-20260827', ext: 'zip', assets: { 'win32-x64': null } }
        }
      },
      sourcesRoot,
      indexPath,
      dryRun: false,
      keep: 0,
      ghClient: gh,
      fetchLocalPath
    })

    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0].message).toMatch(/网络抖动/)
    expect(gh.uploadAsset).not.toHaveBeenCalled()
  })
})