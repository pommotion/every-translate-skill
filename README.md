# every-translate

通用翻译 skill，从 `every-newsletter-pipeline` 的翻译模块抽离而来。

> 翻译任意英文文章到中文，**带事实核查和终审**，输出到独立工作区。

## 快速开始

```bash
# 处理指定 URL
node ~/.agents/skills/every-translate/scripts/every-translate.mjs process \
  --url "https://example.com/article" \
  --processor deepseek

# 健康检查
node ~/.agents/skills/every-translate/scripts/every-translate.mjs preflight
```

## 架构

```
[抓取原文] → [加载名词库] → [翻译] → [吴查查] → [周审稿] → [术语提取] → [输出]
```

## 名词库

- 权威源：remio 笔记合集「📚 Every 翻译名词库」
- 镜像：`glossary/glossary.json`
- 翻译完自动收录新术语

## 关联

- aApp 版本（多轮 UI 流水线）：`remio/aapps-dev/every-translate/`
- 上游 skill（强耦合于 every.beyondmotion.net）：`every-newsletter-pipeline`
