<template>
  <div class="setting-section">
    <div class="section-header">
      <el-icon><Connection /></el-icon>
      <span>{{ t('proxy.title') }}</span>
      <!-- 说明文字改为悬停提示：与 TokenStatistics 的累计Token问号提示同一样式 -->
      <el-tooltip effect="dark" :content="t('proxy.description')" placement="top" popper-class="settings-hint-popper">
        <el-icon class="tooltip-icon"><QuestionFilled /></el-icon>
      </el-tooltip>
    </div>
    <div class="setting-body">
      <el-form label-width="auto">
        <el-form-item :label="t('proxy.enableProxy')" class="form-item-enhanced">
          <el-switch
            :model-value="proxyEnabled_"
            :active-text="t('proxy.enabled')"
            :inactive-text="t('proxy.disabled')"
            @update:model-value="handleProxyToggle"
          />
        </el-form-item>
        <el-form-item v-if="proxyEnabled_" :label="t('proxy.proxyPort')" class="form-item-enhanced">
          <el-input-number
            :model-value="proxyPort_"
            :min="1"
            :max="65535"
            :step="1"
            @update:model-value="handleProxyPortChange"
          />
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Connection, QuestionFilled } from '@element-plus/icons-vue'
import { useProxy } from '../../composables/useProxy'
import { ElMessage } from 'element-plus'

const { t } = useI18n()
const { proxyPort_, proxyEnabled_, setProxySettings } = useProxy()

const handleProxyToggle = async (value: boolean) => {
  if (value === proxyEnabled_.value) return
  if (await setProxySettings(value, proxyPort_.value)) ElMessage.success(t('proxy.statusChanged'))
  else ElMessage.error(t('proxy.portChangeFailed'))
}

const handleProxyPortChange = async (value: number) => {
  const rawValue = proxyPort_.value
  if (rawValue === value) return
  if (await setProxySettings(proxyEnabled_.value, value)) ElMessage.success(t('proxy.portChanged', { oldPort: rawValue, newPort: value }))
  else ElMessage.error(t('proxy.portChangeFailed'))
}
</script>

<style scoped>
.setting-body {
  padding: 4px 0;
}

/* 悬停提示图标：与 TokenStatistics 的提示符号同一配色 */
.tooltip-icon {
  cursor: help;
  color: #a0b3c4;
  font-size: 15px;
  transition: color 0.25s;
}

.tooltip-icon:hover {
  color: var(--brand);
}

.form-item-enhanced {
  margin-bottom: 20px;
}

</style>

<style>
/* setting-section / section-header / tooltip-icon 的公共暗色适配已收敛至 common.css */
</style>
