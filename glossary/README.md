# 📚 Every 翻译名词库（镜像）

**权威源**：remio 笔记合集「📚 Every 翻译名词库」
**同步方向**：remio → 仓库（**单向**，不反向写）
**当前状态**：P1 阶段空数组起步，由真实翻译驱动收录

## 文件

- `glossary.json` — 机器可读镜像（CLI 读取）
- `README.md` — 本文档

## 同步流程

```
[remio 笔记合集]  ← 手工编辑（权威源）
        ↓
[sync-glossary.mjs]  ← 待 P2 实现
        ↓
[glossary/glossary.json]  ← 脚本生成（不手工编辑）
        ↓
[CLI 加载] → 注入 factcheck / rewrite prompt
```

## Schema

```json
{
  "version": "2026-06-04",
  "updatedAt": "2026-06-04T12:00:00.000Z",
  "source": "remio://📚 Every 翻译名词库",
  "terms": [
    {
      "en": "AI Agent",
      "zh": "智能体",
      "context": "通用语境",
      "note": "首次出现建议保留英文"
    }
  ]
}
```

字段说明：
- `en`：英文原词（必填）
- `zh`：中文译名（必填）
- `context`：使用语境（选填）
- `note`：翻译说明/注意事项（选填）

## P1 阶段使用

即便 `terms` 为空，CLI 也会：
1. 读 `glossary.json`
2. 注入到 factcheck prompt 的"专有名词库参考"字段
3. 吴查查用它来核对翻译用词一致性

**0 词条也能跑通**，只是吴查查没词库可参考。

## P2 阶段计划

- 实现 `scripts/sync-glossary.mjs`：
  1. 调 `remio_syscall search_notes` 拉合集「📚 Every 翻译名词库」下所有笔记
  2. 解析每条笔记的 frontmatter 或内容
  3. 合并去重，生成 `glossary.json`
  4. 自动 commit（但**不 push**）

- CI hook：每次翻译前自动跑同步，确保 `glossary.json` 是最新的
