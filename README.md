# DocSentinel · 文档哨兵

长文档 **AI 风格双路循环审查与自动修改** 的桌面应用（Electron）。

## 它做什么

```
B 结构路（结构风格风险）┐
                        ├─ 双路独立并行审查（逐段评分 + 逐字证据 + 程序统计信号）
C 内容路（内容风格风险）┘
        ↓ 任一路超过你设定的阈值
修改 Agent（只改有证据的具体问题，数字/引用强制保护）→ 保存候选版本
        ↓
双路复审 …… 循环，直到低于阈值或达轮数上限
```

- 证据可审计：每条风险与每处修改都必须附原文逐字引文，程序校验对不上不放行
- 程序侧启发式信号（模板句式 / 句长均匀度 / 连接词密度 / 4-gram 重复 / 标点多样性）与模型判断交叉印证，可按领域持续补充短语表
- 标题对齐分块、片段并行执行；B/C/修改四个角色可分别选用不同 API 或本地 Codex CLI
- 原文档字节级保护；导出 DOCX / Markdown 审查报告 / 全版本 ZIP；按阶段统计 token 用量

## 快速开始

```bash
nvm use 24.19.0     # Node >= 24
npm install
npm run dev         # 开发模式
npm run build:win   # 打包 Windows 安装包
```

用户手册见 [使用文档.md](使用文档.md)，依赖说明见 [requirements.txt](requirements.txt)。

## 致谢与来源说明

本项目**参考并基于开源框架 [AutoDocxProofread](https://github.com/CZ600/AutoDocxProofread)（作者 CZ600，MIT License）** 进行开发：

- 沿用其 Electron + Vue 3 + TypeScript 的工程骨架（窗口/IPC/API 配置管理等基础设施）
- 文档读写与原格式回写链路沿用其 docx-edit 方案
- 核心的 B/C 双路循环审查工作流、程序启发式信号、标题对齐分块、并行执行等为在本仓库中的重新设计与实现

感谢原作者的开源工作。本项目的改动同样以 MIT License 发布。
