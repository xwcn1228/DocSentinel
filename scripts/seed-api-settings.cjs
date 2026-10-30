/**
 * 将本地 API 配置写入应用数据库（api_settings 表）。
 *
 * 密钥来源：项目根目录 api-secrets.local.json（已被 .gitignore 忽略，不入库），
 * 文件格式为数组，每项一个配置：
 *   [{ "provider": "glm",   "apiURL": "...", "modelName": "...", "apiKey": "..." }, ...]
 *
 * 说明：
 * - 幂等：同一 provider+apiURL+modelName 已存在时更新密钥，否则插入
 * - 密钥以明文（无 enc:v1: 前缀）写入，这是 apiKeyCrypto.ts 官方兼容路径：
 *   应用读取时原样使用；在应用「API 设置」里保存该配置时会自动升级为 safeStorage 密文
 * - 应用无需预先启动过：数据库/表不存在时会自动创建（结构与 database.ts 一致）
 *
 * 用法：node scripts/seed-api-settings.cjs [配置文件路径，默认 api-secrets.local.json]
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const sqlite3 = require('sqlite3')

const configPath = process.argv[2] || path.join(__dirname, '..', 'api-secrets.local.json')
const pathExists = p => { try { fs.accessSync(p); return true } catch { return false } }
const newPath = path.join(os.homedir(), 'AppData', 'Roaming', 'DocSentinel', 'data', 'app.db')
const legacyPath = path.join(os.homedir(), 'AppData', 'Roaming', 'AutoDocxProofreading', 'data', 'app.db')
const dbPath = pathExists(newPath) || !pathExists(legacyPath) ? newPath : legacyPath

function maskKey(key) {
  return key ? `${key.slice(0, 6)}***` : '(空)'
}

async function main() {
  if (!fs.existsSync(configPath)) {
    console.error(`[seed-api] 配置文件不存在: ${configPath}`)
    console.error('[seed-api] 请按 scripts/seed-api-settings.cjs 顶部注释创建后再运行')
    process.exit(1)
  }
  const configs = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!Array.isArray(configs) || configs.length === 0) {
    console.error('[seed-api] 配置文件需为非空数组')
    process.exit(1)
  }
  for (const c of configs) {
    if (!c.provider || !c.apiURL || !c.modelName || !c.apiKey) {
      console.error(`[seed-api] 配置缺少必填字段（provider/apiURL/modelName/apiKey）: ${JSON.stringify({ ...c, apiKey: maskKey(c.apiKey) })}`)
      process.exit(1)
    }
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new sqlite3.Database(dbPath)

  await new Promise((resolve, reject) => {
    db.run(`CREATE TABLE IF NOT EXISTS api_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      apiURL TEXT NOT NULL,
      apiKey TEXT NOT NULL,
      modelName TEXT NOT NULL,
      provider TEXT DEFAULT 'openai_compatible',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, err => (err ? reject(err) : resolve()))
  })

  for (const c of configs) {
    const existing = await new Promise((resolve, reject) => {
      // 幂等键 provider+modelName；地址被应用 UI 清空的旧行也纳入修复范围
      db.get(
        `SELECT id FROM api_settings WHERE provider = ? AND modelName = ? AND (apiURL = ? OR apiURL = '')`,
        [c.provider, c.modelName, c.apiURL],
        (err, row) => (err ? reject(err) : resolve(row))
      )
    })
    if (existing) {
      await new Promise((resolve, reject) => {
        db.run(`UPDATE api_settings SET apiKey = ?, apiURL = ? WHERE id = ?`, [c.apiKey, c.apiURL, existing.id], err => (err ? reject(err) : resolve()))
      })
      console.log(`[seed-api] 更新 #${existing.id} ${c.provider} · ${c.modelName} · key=${maskKey(c.apiKey)}`)
    } else {
      const result = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO api_settings (apiURL, apiKey, modelName, provider) VALUES (?, ?, ?, ?)`,
          [c.apiURL, c.apiKey, c.modelName, c.provider],
          function cb(err) { err ? reject(err) : resolve(this) }
        )
      })
      console.log(`[seed-api] 插入 #${result.lastID} ${c.provider} · ${c.modelName} · ${c.apiURL} · key=${maskKey(c.apiKey)}`)
    }
  }

  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT id, provider, modelName, apiURL, created_at FROM api_settings ORDER BY id`, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
  console.log(`[seed-api] 当前共 ${rows.length} 条配置:`)
  for (const r of rows) console.log(`  #${r.id} ${r.provider} · ${r.modelName} · ${r.apiURL}`)
  db.close()
}

main().catch(err => {
  console.error('[seed-api] 失败:', err.message)
  process.exit(1)
})
