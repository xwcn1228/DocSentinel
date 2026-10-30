/**
 * dialog 域：文件选择与内容读取（docx / txt / md）
 */
import { ipcMain, dialog } from 'electron'

export const registerDialogHandlers = () => {
  // 处理文件选择请求
  ipcMain.handle('select-docx-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择 DOCX 文件',
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      // 返回文件路径
      return result.filePaths[0]
    } catch (error) {
      console.error('文件选择错误:', error)
      throw error
    }
  })


  // 选择文本/文档文件（txt/md/docx）
  ipcMain.handle('select-format-desc-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择格式描述文件',
        filters: [{ name: '支持的文件', extensions: ['txt', 'md', 'docx'] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    } catch (error) {
      console.error('文件选择错误:', error)
      throw error
    }
  })
}
