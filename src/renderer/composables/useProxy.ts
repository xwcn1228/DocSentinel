// composables/useProxy.ts
import { computed } from 'vue'
import { useProxyStore } from '../stores/proxyStore'

/**
 * 代理设置管理
 * 封装代理的启用、禁用、端口设置等操作
 */
export function useProxy() {
    const proxyStore = useProxyStore()

    // 使用计算属性获取和处理代理状态
    const proxyEnabled_ = computed(() => proxyStore.proxySettings.enabled)
    const proxyPort_ = computed(() => proxyStore.proxySettings.port)


    return {
        // 状态
        proxyEnabled_,
        proxyPort_,
        setProxySettings: proxyStore.setProxySettings,
    }
}
