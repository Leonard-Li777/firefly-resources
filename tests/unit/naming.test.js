import { describe, it, expect } from 'vitest'
import {
  PLATFORM_ARCH,
  DEFAULT_KEY,
  isValidPlatformKey,
  inferPlatformKey,
  assetNameFor
} from '../../lib/naming.js'

describe('naming（资产命名与平台词表）', () => {
  it('平台词表共 7 项且单词合法', () => {
    expect(PLATFORM_ARCH).toHaveLength(7)
    for (const k of PLATFORM_ARCH) expect(isValidPlatformKey(k)).toBe(true)
    expect(isValidPlatformKey('x86_64')).toBe(false)
  })

  it('default 为无平台语义键', () => {
    expect(DEFAULT_KEY).toBe('default')
    expect(isValidPlatformKey(DEFAULT_KEY)).toBe(true)
  })

  it('inferPlatformKey 覆盖主流平台', () => {
    expect(inferPlatformKey('win32', 'x64')).toBe('win32-x64')
    expect(inferPlatformKey('win32', 'arm64')).toBe('win32-arm64')
    expect(inferPlatformKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(inferPlatformKey('darwin', 'x64')).toBe('darwin-x64')
    expect(inferPlatformKey('linux', 'x64')).toBe('linux-x64')
    expect(inferPlatformKey('linux', 'arm64')).toBe('linux-arm64')
    expect(inferPlatformKey('win32', 'ia32')).toBeNull()
    expect(inferPlatformKey('freebsd', 'x64')).toBeNull()
  })

  it('有平台资产名带平台后缀', () => {
    expect(
      assetNameFor({ resourceId: 'ffmpeg', version: '7.1', platformKey: 'win32-x64', ext: 'zip' })
    ).toBe('ffmpeg-7.1-win32-x64.zip')
  })

  it('无平台（default）资产名不带平台后缀', () => {
    expect(
      assetNameFor({ resourceId: 'geo', version: '2026.4', platformKey: 'default', ext: 'tar.gz' })
    ).toBe('geo-2026.4.tar.gz')
  })
})