import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const {
  checkProductContract,
  checkNoDevLocalManifests,
  checkForbiddenResources
} = require('../../../../scripts/verify-bundle-integrity')

const { resolveTopLevelResourceDirs } = require('../../lib/product-assembler')

describe('verify-bundle-integrity 资源契约门禁', () => {
  let tmpRoot

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bundle-gate-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedMinimalValidResources(root) {
    const files = [
      'semantic/semantic.pack',
      'taxonomy/tag-admissibility.json',
      'taxonomy/domain_tag_matrix.json',
      'models/tags_text_embeddings.bin',
      'geo/geonames-compact.json',
      'models/PP-OCRv6/model.onnx',
      'models/magika/model.onnx',
      'bin/omni/onnxruntime.dll',
      'bin/omni/onnxruntime_dml.dll',
      'bin/omni/DirectML.dll',
      'bin/omni/sherpa-onnx-c-api.dll'
    ]
    for (const rel of files) {
      const p = path.join(root, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, 'non-empty-payload')
    }
  }

  const proContract = {
    contractSchema: 1,
    binary: 'firefly-omni',
    version: '0.1.9',
    gitSha: 'abc1234',
    edition: 'pro',
    bootstrapSchema: 1,
    requiredStaticPaths: [
      'semantic/semantic.pack',
      'taxonomy/tag-admissibility.json',
      'taxonomy/domain_tag_matrix.json',
      'models/tags_text_embeddings.bin',
      'geo/geonames-compact.json',
      'models/PP-OCRv6',
      'models/magika'
    ],
    requiredRuntimeLibs: {
      win32: [
        'bin/omni/onnxruntime.dll',
        'bin/omni/onnxruntime_dml.dll',
        'bin/omni/DirectML.dll',
        'bin/omni/sherpa-onnx-c-api.dll'
      ]
    },
    forbiddenPaths: []
  }

  it('Desktop extraResource 派生目录包含 semantic/taxonomy/bin/models/geo/configs', () => {
    const dirs = resolveTopLevelResourceDirs('desktop')
    expect(dirs).toContain('build/extraResources/semantic')
    expect(dirs).toContain('build/extraResources/taxonomy')
    expect(dirs).toContain('build/extraResources/bin')
    expect(dirs).toContain('build/extraResources/models')
    expect(dirs).toContain('build/extraResources/geo')
    expect(dirs).toContain('build/extraResources/configs')
    expect(dirs).toContain('build/extraResources/.VirtualDirectory')
  })

  it('全量合规目录通过 Pro 契约、无 dev-local、无黑名单命中', () => {
    seedMinimalValidResources(tmpRoot)
    const res = checkProductContract(tmpRoot, {
      platform: 'win32',
      loadContract: () => proContract
    })
    expect(res.problems).toEqual([])
    expect(checkNoDevLocalManifests(tmpRoot)).toEqual([])
    expect(checkForbiddenResources(tmpRoot)).toEqual([])
  })

  it('缺失 semantic.pack 时被阻断', () => {
    seedMinimalValidResources(tmpRoot)
    fs.unlinkSync(path.join(tmpRoot, 'semantic/semantic.pack'))
    const res = checkProductContract(tmpRoot, {
      platform: 'win32',
      loadContract: () => proContract
    })
    expect(res.problems.some(p => p.includes('semantic/semantic.pack'))).toBe(true)
  })

  it('混入 CE 二进制时被契约阻断', () => {
    seedMinimalValidResources(tmpRoot)
    const res = checkProductContract(tmpRoot, {
      platform: 'win32',
      loadContract: () => ({ ...proContract, edition: 'ce' })
    })
    expect(res.problems.some(p => p.includes('edition=ce'))).toBe(true)
  })

  it('混入 dev-local 清单凭据时被生产门禁阻断', () => {
    seedMinimalValidResources(tmpRoot)
    fs.writeFileSync(
      path.join(tmpRoot, 'bin/omni/.manifest-omni.json'),
      JSON.stringify({ schemaVersion: 3, assemblyMode: 'dev-local', gitSha: 'deadbeef', files: [] })
    )
    const devHits = checkNoDevLocalManifests(tmpRoot)
    expect(devHits.length).toBe(1)
    expect(devHits[0]).toContain('assemblyMode=dev-local')
  })

  it('黑名单命中 presetResources / visual-vocab / libmupdf / models/ram / models/tagger / tags_text_zh.* / tags_visual_* 时全量阻断', () => {
    seedMinimalValidResources(tmpRoot)
    const forbiddenFiles = [
      'presetResources/geo.tar.gz',
      'visual-vocab/emb-1/vocab_v.f16',
      'libmupdf/fitz.h',
      'libclang/clang.dll',
      'geo-cache/geonames.bin',
      'models/ram/ram_plus.onnx',
      'models/tagger/model.onnx',
      'models/clip/tags_text_zh.bin',
      'models/clip/tags_visual_emb.bin'
    ]
    for (const rel of forbiddenFiles) {
      const p = path.join(tmpRoot, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, 'bad')
    }
    const hits = checkForbiddenResources(tmpRoot)
    expect(hits).toEqual(
      expect.arrayContaining([
        'presetResources/',
        'visual-vocab/',
        'libmupdf/',
        'libclang/',
        'geo-cache/',
        'models/ram/',
        'models/tagger/',
        'models/clip/tags_text_zh.bin',
        'models/clip/tags_visual_emb.bin'
      ])
    )
  })
})
