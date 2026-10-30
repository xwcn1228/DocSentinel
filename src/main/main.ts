import { app, BrowserWindow, session } from 'electron' // app是必须引入的，
import path from 'path'
import fs from 'fs'

// 项目更名（AutoDocxProofreading → DocSentinel）：显式固定 userData 路径，并对
// 旧目录做一次性迁移——保住既有的 API 配置库（data/app.db，密钥按机器加密，
// 同机迁移可继续解密）与历史审查任务（dual-review-runs）。
try {
  const newPath = path.join(app.getPath('appData'), 'DocSentinel')
  const legacyPath = path.join(app.getPath('appData'), 'AutoDocxProofreading')
  if (!fs.existsSync(newPath) && fs.existsSync(legacyPath)) fs.renameSync(legacyPath, newPath)
  if (!fs.existsSync(newPath)) fs.mkdirSync(newPath, { recursive: true })
  app.setPath('userData', newPath)
} catch (error) {
  console.error('userData 迁移失败，回退默认目录:', error)
}

import { registerIpcHandlers } from './ipcHandlers'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// (electron-builder 的 NSIS/portable 安装器自行处理快捷方式，无需 squirrel-startup)

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 1200,
    show: false,
    title: 'AutoDocxProofreading',
    // autoHideMenuBar: true, // 禁用菜单栏
    // 开发态从源码 assets 读取；打包后从 resourcesPath/assets 读取
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'logo.ico')
      : path.join(__dirname, '../../assets/logo.ico'),

    ...(process.platform === 'linux'
      ? { icon: path.join(app.isPackaged ? process.resourcesPath : __dirname, app.isPackaged ? 'assets' : '../../assets', 'logo.ico') }
      : {}),

    webPreferences: {
      // electron-vite 产物：out/main/main.js 的相对路径 → out/preload/preload.js
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    // 设置窗口样式
    // remove the default titlebar；窗口控制按钮由渲染层 top-toolbar 内的自定义按钮提供
    titleBarStyle: 'hidden'
  })

  // load the index.html of the app.
  // electron-vite dev 时注入 ELECTRON_RENDERER_URL；打包后从 out/renderer/index.html 加载
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // Open the DevTools.
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.maximize()
  mainWindow.show()

  // 最大化状态变化时通知渲染端，用于切换最大化/还原图标
  const sendMaximizeState = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximizeChanged', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaximizeState)
  mainWindow.on('unmaximize', sendMaximizeState)
}

app.whenReady().then(async () => {
  // 当应用准备好之后，回调函数
  console.log('app is ready')
  console.log('then will create a window')

  console.log('中文测试')
  createWindow()

  // 设置 Content-Security-Policy（CSP），跨站脚本攻击 (XSS) 和其他代码注入攻击
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["script-src 'self'"]
      }
    })
  })
  // 当窗口被激活的时候，要判断是否有窗口打开，如果没有打开，那么就创建一个窗口（也是针对苹果系统作出的优化）
  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // 当所有的窗口都关闭的时候并且不是macos的时候，那么关闭软件
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

registerIpcHandlers()
