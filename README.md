# firefly-resources

共享二进制资源统一分发仓库（Open-Core）。

- 决策依据：`docs/adr/0029-unified-resource-distribution.md`（monorepo 侧）
- 实现方案：`docs/developer/infra/unified-resource-distribution.md`（monorepo 侧）

## 结构

```
├── index.json             # 资源索引（schema v1，聚合所有资源版本/资产/sha256/latest）
├── publish-resources.js   # 发布脚本 CLI（迁移/手工上传 → 上传 assets → 更新 index）
├── verify-release-resources.js  # 消费方发版前置校验（装配清单 ↔ 索引一致性）
├── render-release-note.js # 装配清单 → Release 说明"配套资源"区块
├── sources/*.json         # 各资源的上游获取规则（provider / assetMap / 压缩格式）
├── manifests/             # 发布/聚合清单审计归档（仅存可复现清单，如 omni-<version>.json、libmupdf 在线归档；不含开发机本地路径的一次性迁移清单）
├── lib/                   # 共享基础库（命名/索引/哈希/gh 封装/upstream/fetch）
└── tests/unit/            # Vitest 单元测试
```

## 容器 tag

恒定 tag `resources` 作为资产发布位置，不承载版本语义。
资产命名：有平台语义 `{resourceId}-{version}-{platform}-{arch}.{ext}`，无平台语义 `{resourceId}-{version}.{ext}`。
平台键词汇表（`lib/naming.js`）：`win32-x64 / win32-arm64 / darwin-x64 / darwin-arm64 / darwin-universal / linux-x64 / linux-arm64 / default`。
**同名资产不可覆盖**（GitHub 422 + 索引不可变校验），升级只能新增版本。

## 已收录资源

| 资源 ID          | type    | provider                       | 说明                                             |
| ---------------- | ------- | ------------------------------ | ------------------------------------------------ |
| ffmpeg / ffprobe | tool    | `BtbN/FFmpeg-Builds`           | 多媒体处理，按平台架构拆分                       |
| fastfetch        | tool    | 本地 manifest / 在线           | 系统信息                                         |
| llama-model-download | tool | 本地 manifest / BtbN           | 模型下载器                                       |
| exiftool         | tool    | 本地 manifest                  | 元数据提取                                       |
| geo              | data    | 本地 manifest                  | geonames-compact（omni-geo）                     |
| LFM2.5-1.2B-Instruct | data | 本地发布                     | 内置默认分析模型 GGUF                            |
| libmupdf         | library | `firefly-omni-ci-resources`    | omni 构建期静态库（assetMap 对齐七词表）         |
| firefly-omni     | engine  | `firefly-omni-release`         | desktop 装配引擎二进制（主通道走 CI 聚合发布）   |

## 使用

```bash
# 发布（迁移/手动）：根据 manifest 上传资产并重建 index
node publish-resources.js --manifest release-manifest.json --keep 5

# 在线来源自动拉取（本地缺失平台资产时，从 sources provider 拉取重打包）
node publish-resources.js --manifest ffmpeg-master.json --offline   # --offline 禁用在线拉取

# 发版前置校验（消费方 CI 在 gh release create 前执行）
node verify-release-resources.js --bom ../apps/desktop/build/extraResources/configs/resources.bom.json --index-local index.json

# 渲染 Release 说明"配套资源"区块
node render-release-note.js --bom ../apps/desktop/build/extraResources/configs/resources.bom.json
```

`publish-resources.js` 零 npm 依赖（node 内置 + `gh` CLI），可直接在任意 CI 克隆后运行。

## firefly-omni 生产发布链路

- omni `apps/omni/.github/workflows/omni-build.yml`（edition=pro）：matrix 6 平台构建 release 二进制 → `publish-pro` 聚合 job 克隆本仓库并执行 `apps/omni/scripts/publish-unisource.js`：
  1. 扫描构件目录，按命名映射平台键（未收集到的平台自动跳过）；
  2. 组装多平台 manifest 写入 `manifests/omni-<version>.json`；
  3. 调 `publish-resources.js --manifest` 上传 `resources` tag 并回写本地 `index.json`；
  4. 提交并推送 `main`（需 secret `UNISOURCE_RELEASE_TOKEN`）。
- 消费端 `scripts/download-preset-resources.js` 3.4.7 从本仓库 `main/index.json` 按平台键解析并下载装配。
- 本地手动发布可复用 `publish-unisource.js`（`--dry-run` / `--fr <本仓库目录>` 调试）。

## 测试

```bash
pnpm test
```