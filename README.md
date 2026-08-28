# firefly-resources

共享二进制资源统一分发仓库（Open-Core）。

- 决策依据：`docs/adr/0029-unified-resource-distribution.md`（monorepo 侧）
- 实现方案：`docs/developer/infra/unified-resource-distribution.md`（monorepo 侧）

## 结构

```
├── index.json             # 资源索引（schema v1，聚合所有资源版本/资产/sha256/latest）
├── publish-resources.js   # 发布脚本（迁移/手工上传 → 更新 index）
├── verify-release-resources.js  # 消费方发版前置校验（装配清单 ↔ 索引一致性）
├── render-release-note.js # 装配清单 → Release 说明"配套资源"区块
├── sources/*.json         # 各资源的上游获取规则（规划 + 刷新指引）
├── lib/                   # 共享基础库（命名/索引/哈希/gh 封装）
└── tests/unit/            # Vitest 单元测试
```

## 容器 tag

恒定 tag `resources` 作为资产发布位置，不承载版本语义。
资产命名：有平台语义 `{resourceId}-{version}-{platform}-{arch}.{ext}`，无平台语义 `{resourceId}-{version}.{ext}`。
**同名资产不可覆盖**（GitHub 422 + 索引不可变校验），升级只能新增版本。

## 使用

```bash
# 发布（迁移/手动）：根据 manifest 上传资产并重建 index
node publish-resources.js --manifest release-manifest.json --keep 5

# 发版前置校验（消费方 CI 在 gh release create 前执行）
node verify-release-resources.js --bom ../apps/desktop/build/extraResources/resources.bom.json

# 渲染 Release 说明"配套资源"区块
node render-release-note.js --bom ../apps/desktop/build/extraResources/resources.bom.json
```

## 测试

```bash
pnpm test
```