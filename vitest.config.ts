import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // dsh-plugin 是独立包，测试跑在 node --test 上（见 dsh-plugin/package.json）
    // wordProcess.test.js / proofTable.test.cjs 是自带 main() 运行器的独立 node 脚本
    // （依赖 tsc 预编译的 __tests__/tmp_compile 产物），用 npm run test:word-process / test:proof-table 运行
    exclude: ['**/node_modules/**', 'dsh-plugin/**', '__tests__/wordProcess.test.js', '__tests__/proofTable.test.cjs']
  }
})
