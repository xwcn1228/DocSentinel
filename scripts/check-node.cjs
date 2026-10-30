// Node 版本门禁：项目要求 Node >= 24（.nvmrc 指定 24.x，engines 同步约束）。
// 用低版本 Node 跑测试会出现 structuredClone is not defined 等难排查的错误，
// 本脚本在 dev/build/test 前给出明确提示。以 CJS 编写，保证低版本 Node 也能执行到提示。
const REQUIRED_MAJOR = 24
const major = Number(process.versions.node.split('.')[0])

if (major < REQUIRED_MAJOR) {
  console.error(`[check-node] 当前 Node v${process.versions.node}，本项目要求 Node >= ${REQUIRED_MAJOR}。`)
  console.error('[check-node] Windows(nvm) 切换：nvm use 24.19.0 ；或安装 Node 24 后重试。')
  console.error('[check-node] 参见 .nvmrc 与 package.json engines 字段。')
  process.exit(1)
}
