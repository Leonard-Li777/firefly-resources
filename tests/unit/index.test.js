import { describe, it, expect } from 'vitest'
import {
  emptyIndex,
  upsertAsset,
  setLatest,
  compareVersions,
  sortVersions,
  resolveLatestVersion,
  resolveLatestAsset,
  hasAssetWithSha,
  collectPrunableVersions,
  removeVersions
} from '../../lib/index.js'

describe('index（索引协议）', () => {
  it('emptyIndex 生成 schema v1 空索引', () => {
    const idx = emptyIndex('resources')
    expect(idx.schema).toBe(1)
    expect(idx.containerTag).toBe('resources')
    expect(idx.resources).toEqual({})
  })

  it('upsertAsset 幂等：同 sha 跳过，异 sha 拒绝不可变', () => {
    const idx = emptyIndex()
    const asset = {
      resourceId: 'ffmpeg',
      version: '7.1',
      platformKey: 'win32-x64',
      name: 'ffmpeg-v7.1-win32-x64.zip',
      sha256: 'a'.repeat(64),
      size: 100
    }
    expect(upsertAsset(idx, asset)).toEqual({ skipped: false })
    expect(upsertAsset(idx, asset)).toEqual({ skipped: true })
    expect(() =>
      upsertAsset(idx, { ...asset, sha256: 'b'.repeat(64) })
    ).toThrow(/不可变/)
  })

  it('compareVersions 按点分数字比较，容忍尾缀', () => {
    expect(compareVersions('7.1', '7.10')).toBeLessThan(0)
    expect(compareVersions('7.10', '7.2')).toBeGreaterThan(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('b10582', 'b10583')).toBeLessThan(0)
  })

  it('sortVersions 升序', () => {
    expect(sortVersions(['7.1', '7.10', '7.2'])).toEqual(['7.1', '7.2', '7.10'])
  })

  it('resolveLatestVersion：latest 具体版本 / 字面量 latest 取最大', () => {
    const idx = emptyIndex()
    upsertAsset(idx, { resourceId: 'llama', version: 'b1', platformKey: 'default', name: 'llama-b1.zip', sha256: 'a'.repeat(64), size: 1 })
    upsertAsset(idx, { resourceId: 'llama', version: 'b10582', platformKey: 'default', name: 'llama-b10582.zip', sha256: 'a'.repeat(64), size: 1 })
    setLatest(idx, 'llama', 'latest')
    expect(resolveLatestVersion(idx, 'llama')).toBe('b10582')
    setLatest(idx, 'llama', 'b1')
    expect(resolveLatestVersion(idx, 'llama')).toBe('b1')
  })

  it('resolveLatestAsset 返回平台资产', () => {
    const idx = emptyIndex()
    upsertAsset(idx, { resourceId: 'ffmpeg', version: '7.1', platformKey: 'win32-x64', name: 'ffmpeg-v7.1-win32-x64.zip', sha256: 'a'.repeat(64), size: 10 })
    const hit = resolveLatestAsset(idx, 'ffmpeg', 'win32-x64')
    expect(hit).toMatchObject({ version: '7.1', asset: { name: 'ffmpeg-v7.1-win32-x64.zip' } })
    expect(resolveLatestAsset(idx, 'ffmpeg', 'linux-x64')).toBeNull()
  })

  it('hasAssetWithSha 按资产名+sha 命中', () => {
    const idx = emptyIndex()
    upsertAsset(idx, { resourceId: 'geo', version: '2026.4', platformKey: 'default', name: 'geo-2026.4.tar.gz', sha256: 'ab'.repeat(32), size: 5 })
    expect(hasAssetWithSha(idx, 'geo', 'geo-2026.4.tar.gz', 'ab'.repeat(32))).toBe(true)
    expect(hasAssetWithSha(idx, 'geo', 'geo-2026.4.tar.gz', 'ff'.repeat(32))).toBe(false)
    expect(hasAssetWithSha(idx, 'nope', 'x', 'ab'.repeat(32))).toBe(false)
  })

  it('collectPrunableVersions + removeVersions 裁剪历史保留最新', () => {
    const idx = emptyIndex()
    for (const v of ['1.0', '2.0', '3.0']) {
      upsertAsset(idx, { resourceId: 'poppler', version: v, platformKey: 'default', name: `poppler-${v}.zip`, sha256: 'a'.repeat(64), size: 1 })
    }
    const prunable = collectPrunableVersions(idx, 'poppler', 1)
    expect(prunable.versions).toEqual(['1.0', '2.0'])
    expect(prunable.assetNames).toEqual(['poppler-1.0.zip', 'poppler-2.0.zip'])
    removeVersions(idx, 'poppler', prunable.versions)
    expect(Object.keys(idx.resources.poppler.versions)).toEqual(['3.0'])
  })
})