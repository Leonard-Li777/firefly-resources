import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildUpstreamManifest, extOf, platformMapOf } from '../../publish-resources.js'

function makeSources(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-manifest-'))
  const root = path.join(dir, 'sources')
  fs.mkdirSync(root)
  for (const [id, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify(content), 'utf8')
  }
  return root
}

const indexWith = versions => ({ schema: 1, resources: versions })

describe('buildUpstreamManifest（--upstream 清单构造）', () => {
  it('BtbN 类：版本取索引当前版本，平台取 upstream.platforms，扩展名统一 zip', async () => {
    const sourcesRoot = makeSources({
      ffmpeg: {
        resourceId: 'ffmpeg',
        type: 'tool',
        upstream: {
          kind: 'online',
          provider: 'BtbN/FFmpeg-Builds',
          platforms: {
            'win32-x64': 'ffmpeg-master-latest-win64-gpl.zip',
            'linux-x64': 'ffmpeg-master-latest-linux64-gpl.tar.xz'
          }
        }
      }
    })
    const index = indexWith({
      ffmpeg: { type: 'tool', latest: 'master-20260827', versions: { 'master-20260827': {} } }
    })

    const { manifest, skipped, problems } = await buildUpstreamManifest({
      sourcesRoot,
      index,
      ids: ['ffmpeg']
    })

    expect(problems).toEqual([])
    expect(skipped).toEqual([])
    expect(manifest.resources.ffmpeg.version).toBe('master-20260827')
    expect(manifest.resources.ffmpeg.ext).toBe('zip')
    expect(Object.keys(manifest.resources.ffmpeg.assets)).toEqual(['win32-x64', 'linux-x64'])
    expect(manifest.resources.ffmpeg.assets['linux-x64'].ext).toBe('zip')
    expect(manifest.resources.ffmpeg.assets['win32-x64'].path).toBeNull()
  })

  it('assetMap 类：{tag} 模板按版本替换，扩展名按上游文件名逐平台推断', async () => {
    const sourcesRoot = makeSources({
      'llama-cpp': {
        resourceId: 'llama-cpp',
        type: 'engine',
        upstream: {
          kind: 'online',
          provider: 'llama-compat-release',
          repo: 'Leonard-Li777/firefly-ai-folder',
          assetMap: {
            'win32-x64': 'llama-{tag}-bin-win-cpu-x64.zip',
            'linux-x64': 'llama-{tag}-bin-ubuntu-x64.tar.gz'
          }
        }
      }
    })
    const index = indexWith({
      'llama-cpp': { type: 'engine', latest: 'b12345', versions: { b12345: {} } }
    })

    const { manifest } = await buildUpstreamManifest({ sourcesRoot, index, ids: ['llama-cpp'] })

    expect(manifest.resources['llama-cpp'].version).toBe('b12345')
    expect(manifest.resources['llama-cpp'].assets['win32-x64'].ext).toBe('zip')
    expect(manifest.resources['llama-cpp'].assets['linux-x64'].ext).toBe('tar.gz')
    // 混合扩展名时 def.ext 仅作兜底，真实扩展名在 assets 内逐平台声明
    expect(manifest.resources['llama-cpp'].ext).toBeTruthy()
  })

  it('非在线/无平台映射的资源进 skipped，不阻断其它资源', async () => {
    const sourcesRoot = makeSources({
      moss: { resourceId: 'moss', type: 'data', upstream: { kind: 'custom' } },
      sensevoice: {
        resourceId: 'sensevoice',
        type: 'data',
        upstream: { kind: 'online', provider: 'k2-fsa/sherpa-onnx' }
      },
      ffmpeg: {
        resourceId: 'ffmpeg',
        type: 'tool',
        upstream: {
          kind: 'online',
          provider: 'BtbN/FFmpeg-Builds',
          platforms: { 'win32-x64': 'ffmpeg.zip' }
        }
      }
    })
    const index = indexWith({
      ffmpeg: { type: 'tool', latest: 'master-20260827', versions: { 'master-20260827': {} } }
    })

    const { manifest, skipped, problems } = await buildUpstreamManifest({
      sourcesRoot,
      index,
      ids: 'all'
    })

    expect(problems).toEqual([])
    expect(skipped.map(s => s.resourceId).sort()).toEqual(['moss', 'sensevoice'])
    expect(Object.keys(manifest.resources)).toEqual(['ffmpeg'])
  })

  it('显式指定且 sources 不存在的资源计入 problems（不静默跳过）', async () => {
    const sourcesRoot = makeSources({})
    const { problems } = await buildUpstreamManifest({
      sourcesRoot,
      index: indexWith({}),
      ids: ['nope']
    })
    expect(problems[0].resourceId).toBe('nope')
  })

  it('索引无版本且上游无 tag 时用解析器兜底', async () => {
    const sourcesRoot = makeSources({
      ffmpeg: {
        resourceId: 'ffmpeg',
        type: 'tool',
        upstream: {
          kind: 'online',
          provider: 'BtbN/FFmpeg-Builds',
          platforms: { 'win32-x64': 'x.zip' }
        }
      }
    })
    const { manifest } = await buildUpstreamManifest({
      sourcesRoot,
      index: indexWith({}),
      ids: ['ffmpeg'],
      resolveOnlineVersion: async () => 'master-20261124'
    })
    expect(manifest.resources.ffmpeg.version).toBe('master-20261124')
  })

  it('all 模式：无法定版本的资源只跳过，不阻断可发布资源', async () => {
    const sourcesRoot = makeSources({
      engine: {
        resourceId: 'engine',
        type: 'engine',
        upstream: {
          kind: 'online',
          provider: 'firefly-ai-engine-release',
          assetMap: { 'win32-x64': 'x.zip' }
        }
      },
      ffmpeg: {
        resourceId: 'ffmpeg',
        type: 'tool',
        upstream: {
          kind: 'online',
          provider: 'BtbN/FFmpeg-Builds',
          platforms: { 'win32-x64': 'x.zip' }
        }
      }
    })
    const index = indexWith({
      ffmpeg: { type: 'tool', latest: 'master-1', versions: { 'master-1': {} } }
    })

    const { manifest, skipped, problems } = await buildUpstreamManifest({
      sourcesRoot,
      index,
      ids: 'all',
      strict: false
    })

    expect(problems).toEqual([])
    expect(skipped.map(s => s.resourceId)).toContain('engine')
    expect(Object.keys(manifest.resources)).toEqual(['ffmpeg'])
  })

  it('显式指定 deprecated 资源时失败（不发布）', async () => {
    const sourcesRoot = makeSources({
      ffprobe: {
        resourceId: 'ffprobe',
        type: 'tool',
        deprecated: true,
        upstream: {
          kind: 'online',
          provider: 'BtbN/FFmpeg-Builds',
          platforms: { 'win32-x64': 'x.zip' }
        }
      }
    })
    const { problems } = await buildUpstreamManifest({
      sourcesRoot,
      index: indexWith({}),
      ids: ['ffprobe'],
      strict: true
    })
    expect(problems[0].resourceId).toBe('ffprobe')
  })

  it('extOf / platformMapOf 基本契约', () => {
    expect(extOf('a.tar.gz', 'x')).toBe('tar.gz')
    expect(extOf('a.zip', 'x')).toBe('zip')
    expect(extOf('a.tar.xz', 'BtbN/FFmpeg-Builds')).toBe('zip')
    expect(platformMapOf({ upstream: { assetMap: { a: 'b' } } })).toEqual({ a: 'b' })
    expect(platformMapOf({ upstream: { kind: 'manual' } })).toBeNull()
  })
})
