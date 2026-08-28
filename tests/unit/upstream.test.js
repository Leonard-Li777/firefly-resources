import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BTBN_TEMPLATES,
  getBtbNMasterVersion,
  btbNSupports,
  fetchBtbNSingle,
  findExecutable,
  repackZipSingle
} from '../../lib/upstream.js'

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('upstream（BtbN 在线来源）', () => {
  it('平台模板覆盖 win/linux 双架构，不含 macOS', () => {
    expect(Object.keys(BTBN_TEMPLATES).sort()).toEqual(
      ['linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].sort()
    )
    expect(BTBN_TEMPLATES['win32-x64'].kind).toBe('zip')
    expect(BTBN_TEMPLATES['linux-x64'].kind).toBe('tar.xz')
    expect(btbNSupports('win32-arm64')).toBe(true)
    expect(btbNSupports('darwin-arm64')).toBe(false)
  })

  it('从 latest release 的 published_at 派生 master-YYYYMMDD 版本', async () => {
    const fetchText = vi.fn(async () =>
      JSON.stringify({ published_at: '2026-08-27T17:13:10Z' })
    )
    const version = await getBtbNMasterVersion({ fetchText })
    expect(version).toBe('master-20260827')
    expect(fetchText).toHaveBeenCalledWith(
      'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'
    )
  })

  it('latest 查询失败时抛出', async () => {
    const fetchText = vi.fn(async () => null)
    await expect(getBtbNMasterVersion({ fetchText })).rejects.toThrow(/latest release/)
  })

  it('不支持平台返回 null（macOS 走本地兜底）', async () => {
    const out = await fetchBtbNSingle({
      resourceId: 'ffmpeg',
      version: 'master-20260827',
      platformKey: 'darwin-x64',
      cacheDir: makeTempDir('upext-')
    })
    expect(out).toBeNull()
  })

  it('findExecutable 在 bin/ 下定位目标二进制', () => {
    const dir = makeTempDir('upbin-')
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'bin', 'ffprobe.exe'), 'x', 'utf8')
    expect(findExecutable(dir, 'ffprobe', '.exe')).toBe(path.join(dir, 'bin', 'ffprobe.exe'))
    expect(findExecutable(dir, 'ffmpeg', '.exe')).toBeNull()
  })

  it('repackZipSingle 将单文件打包为可列出的 zip', async () => {
    const dir = makeTempDir('upzip-')
    const exe = path.join(dir, 'ffmpeg.exe')
    fs.writeFileSync(exe, 'this-is-the-binary-body', 'utf8')
    const outZip = path.join(dir, 'ffmpeg-master-20260827-win32-x64.zip')
    repackZipSingle(exe, outZip, 'ffmpeg.exe')

    const { spawnSync } = await import('node:child_process')
    const listing = spawnSync('tar', ['-tf', outZip], { encoding: 'utf8' })
    expect(listing.status).toBe(0)
    expect(listing.stdout.trim()).toBe('ffmpeg.exe')
  })

  it('fetchBtbNSingle 输出 zip 已存在时幂等复用（不重复重打包）', async () => {
    const dir = makeTempDir('uppid-')
    const extract = path.join(dir, 'extract-win32-x64', 'bin')
    fs.mkdirSync(extract, { recursive: true })
    fs.writeFileSync(path.join(extract, 'ffprobe.exe'), 'exe-body', 'utf8')
    const outZip = path.join(dir, 'ffprobe-master-20260827-win32-x64.zip')
    fs.writeFileSync(outZip, 'pre-existing-zip', 'utf8')
    const dep = { downloadFile: vi.fn() }
    const first = await fetchBtbNSingle(
      { resourceId: 'ffprobe', version: 'master-20260827', platformKey: 'win32-x64', cacheDir: dir },
      dep
    )
    expect(first).toBe(outZip)
    const retried = await fetchBtbNSingle(
      { resourceId: 'ffprobe', version: 'master-20260827', platformKey: 'win32-x64', cacheDir: dir },
      dep
    )
    expect(retried).toBe(outZip)
    expect(fs.readFileSync(outZip, 'utf8')).toBe('pre-existing-zip')
  })
})