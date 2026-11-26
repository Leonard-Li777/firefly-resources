import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import assembler from '../../lib/product-assembler.js'

const {
  loadProductManifest,
  resolveTopLevelResourceDirs,
  assembleProduct,
  signDevLocalManifest,
  verifyDirectoryManifest
} = assembler

const tmpDirs = []
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

afterEach(() => {
  delete process.env.NODE_ENV
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
  }
})

describe('ProductResourceAssembler（声明式产品装配深模块）', () => {
  it('拒绝构建独立 omni-pro 产品包，且仅放行 desktop / omni-ce / engine', () => {
    expect(() => loadProductManifest('omni-pro')).toThrow(/omni-pro/)
    expect(loadProductManifest('omni-ce').entries.map(e => e.id)).toEqual(['exiftool'])
    const desktopDirs = resolveTopLevelResourceDirs('desktop')
    expect(desktopDirs).toContain('build/extraResources/semantic')
    expect(desktopDirs).toContain('build/extraResources/taxonomy')
    expect(desktopDirs).toContain('build/extraResources/bin')
    expect(desktopDirs).toContain('build/extraResources/models')
    expect(loadProductManifest('desktop').entries.some(e => e.id === 'ram-assets')).toBe(false)
  })

  it('多构件共写 bin/omni 生成唯一独占合并清单 v3 并自动清理清单外脏文件', async () => {
    const root = mkTmp('asm-merge-')
    const targetRoot = path.join(root, 'extraResources')
    const presetDir = path.join(root, 'preset')
    const productsDir = path.join(root, 'products')
    fs.mkdirSync(productsDir, { recursive: true })

    // 写入夹具产品清单（双构件汇入 bin/omni）
    fs.writeFileSync(
      path.join(productsDir, 'desktop.resources.json'),
      JSON.stringify({
        schemaVersion: 1,
        product: 'desktop',
        entries: [
          { id: 'firefly-omni', origin: 'shared-index', sourceKind: 'engine', dest: 'bin/omni', required: true },
          { id: 'onnxruntime-directml', origin: 'shared-index', dest: 'bin/omni', required: true }
        ]
      })
    )

    const omniZipContent = Buffer.from('omni-binary-payload')
    const ortZipContent = Buffer.from('ort-dlls-payload')
    const indexPath = path.join(root, 'index.json')
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        schema: 1,
        containerTag: 'resources',
        resources: {
          'firefly-omni': {
            type: 'engine',
            latest: 'v0.1.9',
            versions: {
              'v0.1.9': {
                'win32-x64': { name: 'omni.zip', sha256: sha256Buf(omniZipContent), size: omniZipContent.length }
              }
            }
          },
          'onnxruntime-directml': {
            type: 'tool',
            latest: '1.24.4',
            versions: {
              '1.24.4': {
                'win32-x64': { name: 'ort.zip', sha256: sha256Buf(ortZipContent), size: ortZipContent.length }
              }
            }
          }
        }
      })
    )

    // 预先在 bin/omni 放入未受控的脏 DLL 残留
    const omniDir = path.join(targetRoot, 'bin/omni')
    fs.mkdirSync(omniDir, { recursive: true })
    fs.writeFileSync(path.join(omniDir, 'stale-orphan.dll'), 'dirty')

    const extractArchive = (archivePath, stageDir) => {
      const name = path.basename(archivePath)
      if (name === 'omni.zip') {
        fs.writeFileSync(path.join(stageDir, 'firefly-omni.exe'), 'v0.1.9-exe')
      } else if (name === 'ort.zip') {
        fs.writeFileSync(path.join(stageDir, 'onnxruntime.dll'), 'ort')
        fs.writeFileSync(path.join(stageDir, 'DirectML.dll'), 'dml')
      }
    }
    const downloadAsset = async ({ assetName, destPath }) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.writeFileSync(destPath, assetName === 'omni.zip' ? omniZipContent : ortZipContent)
      return destPath
    }

    const res = await assembleProduct({
      product: 'desktop',
      mode: 'release-locked',
      targetRoot,
      presetDir,
      productsDir,
      indexPath,
      platform: 'win32',
      arch: 'x64',
      extractArchive,
      downloadAsset
    })

    expect(res.cleanedExtraFiles['bin/omni']).toEqual(['stale-orphan.dll'])
    expect(fs.existsSync(path.join(omniDir, 'stale-orphan.dll'))).toBe(false)
    expect(fs.existsSync(path.join(omniDir, 'firefly-omni.exe'))).toBe(true)
    expect(fs.existsSync(path.join(omniDir, 'DirectML.dll'))).toBe(true)

    const verify = verifyDirectoryManifest(omniDir, { strictExclusive: true })
    expect(verify.ok).toBe(true)
    expect(verify.manifest.sources.map(s => s.id)).toEqual(['firefly-omni', 'onnxruntime-directml'])

    // 二次幂等运行应跳过解压
    const res2 = await assembleProduct({
      product: 'desktop',
      mode: 'release-locked',
      targetRoot,
      presetDir,
      productsDir,
      indexPath,
      platform: 'win32',
      arch: 'x64',
      extractArchive: () => {
        throw new Error('不应再次触发解压')
      },
      downloadAsset
    })
    expect(res2.skipped).toEqual(['bin/omni'])
  })

  it('dev-local 覆盖重签后不被旧锁回退，且生产模式严格拦截 dev-local 凭据', async () => {
    const root = mkTmp('asm-devlocal-')
    const targetRoot = path.join(root, 'extraResources')
    const presetDir = path.join(root, 'preset')
    const productsDir = path.join(root, 'products')
    fs.mkdirSync(productsDir, { recursive: true })

    fs.writeFileSync(
      path.join(productsDir, 'omni-ce.resources.json'),
      JSON.stringify({
        schemaVersion: 1,
        product: 'omni-ce',
        entries: [{ id: 'exiftool', origin: 'shared-index', dest: 'bin/exiftool', required: true }]
      })
    )
    const zipBytes = Buffer.from('locked-exiftool')
    const indexPath = path.join(root, 'index.json')
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        schema: 1,
        containerTag: 'resources',
        resources: {
          exiftool: {
            type: 'tool',
            latest: '13.59',
            versions: {
              '13.59': { 'win32-x64': { name: 'exif.zip', sha256: sha256Buf(zipBytes), size: zipBytes.length } }
            }
          }
        }
      })
    )

    const localExe = path.join(root, 'local-exiftool.exe')
    fs.writeFileSync(localExe, 'new-local-build')

    const res = await assembleProduct({
      product: 'omni-ce',
      mode: 'dev-local',
      targetRoot,
      presetDir,
      productsDir,
      indexPath,
      platform: 'win32',
      arch: 'x64',
      localOverrides: {
        exiftool: { version: 'dev-local', gitSha: 'abcdef1', files: [{ src: localExe, relPath: 'exiftool.exe' }] }
      }
    })
    expect(res.manifests['bin/exiftool'].assemblyMode).toBe('dev-local')
    expect(fs.readFileSync(path.join(targetRoot, 'bin/exiftool/exiftool.exe'), 'utf8')).toBe('new-local-build')

    // 仅运行 signDevLocalManifest 后应依然通过严格校验而不被旧锁覆盖
    fs.writeFileSync(path.join(targetRoot, 'bin/exiftool/exiftool.exe'), 'recompiled-2')
    signDevLocalManifest({
      targetRoot,
      dirRel: 'bin/exiftool',
      sourceId: 'exiftool',
      version: 'dev-local',
      gitSha: 'deadbeef'
    })
    const devCheck = verifyDirectoryManifest(path.join(targetRoot, 'bin/exiftool'), {
      strictExclusive: true,
      forbidDevLocal: true
    })
    expect(devCheck.ok).toBe(false)
    expect(devCheck.reason).toBe('dev_local_forbidden_in_production')

    // NODE_ENV=production 严格禁止调用 dev-local 装配
    process.env.NODE_ENV = 'production'
    await expect(
      assembleProduct({
        product: 'omni-ce',
        mode: 'dev-local',
        targetRoot,
        presetDir,
        productsDir,
        indexPath
      })
    ).rejects.toThrow(/NODE_ENV=production/)
  })
})
