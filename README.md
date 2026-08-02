# Fiber Gateway Introduction

这是 [`fiber-gateway-cpp`](https://github.com/fiber-net-gateway/fiber-gateway-cpp) 的中文介绍站点，重点展示：

- `ai-server`：兼容 OpenAI Chat Completions 与 Anthropic Messages 的 LLM 代理；
- `lite-nginx`：支持 HTTP/1.1、HTTP/2、HTTP/3 与 WebSocket 的轻量反向代理；
- `access-server`：面向 Java `ploto-unified-access` 行为兼容的 C++23 迁移实现。

页面内容基于本地下载到 `.temp/fiber-gateway-cpp` 的源码和项目文档整理。首版对应上游提交 `fdd8f12`（2026-08-02）。该目录已加入 `.gitignore`，不会提交到介绍站仓库。

## 本地开发

```bash
npm install
npm run dev
```

Vite 默认会输出本地访问地址。

类型检查与格式化：

```bash
npm run typecheck
npm run format
npm run format:check
```

## 构建静态页面

```bash
npm run build
npm run preview
```

生产文件生成在 `dist/`。资源路径采用相对地址，可直接部署在域名根目录或 GitHub Pages 等子路径。

## 内容依据

首版页面主要参考上游仓库中的：

- `README.md` 与 `README.zh-CN.md`
- `apps/ai-server/README.md`、`apps/ai-server/docs/architecture.md`
- `apps/lite_nginx/README.md`
- `apps/access-server/README.md`、`apps/access-server/docs/compatibility-contract.md`

上游项目仍处于活跃开发阶段，应用契约和状态可能继续变化。更新介绍内容前，可重新拉取本地参考源码：

```bash
git -C .temp/fiber-gateway-cpp pull --ff-only
```

## 技术栈

- React + TypeScript
- Vite
- Lucide icons
- 原生 CSS（响应式布局、微交互与无障碍降级）
- Prettier（统一 TypeScript、CSS、Markdown 与配置文件格式）

## 上游项目

GitHub：<https://github.com/fiber-net-gateway/fiber-gateway-cpp>
