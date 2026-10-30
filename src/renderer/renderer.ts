import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
// Element Plus 组件本体由 unplugin-vue-components 按需注入（含样式）；
// ElMessage / ElMessageBox 是编程式 API，组件 resolver 覆盖不到，样式需显式引入
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import './assets/css/tokens.css'
import './assets/css/common.css'
import './assets/css/preview.css'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { setupI18n } from './i18n'
import { useLocaleStore } from './stores/localeStore'
import { useProxyStore } from './stores/proxyStore'

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(router)
app.use(pinia)

const i18n = setupI18n()
app.use(i18n)

const localeStore = useLocaleStore()
i18n.global.locale.value = localeStore.locale

// Reapply persisted proxy settings to Electron after each launch. The previous
// default was 33210; migrate it to the user's confirmed local proxy port.
const proxyStore = useProxyStore()
if (proxyStore.proxySettings.port === 33210) proxyStore.proxySettings.port = 7890
void proxyStore.setProxySettings(proxyStore.proxySettings.enabled, proxyStore.proxySettings.port)

app.mount('#app')
