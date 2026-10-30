import { createRouter, createWebHashHistory } from 'vue-router'

// 路由级代码分割：页面组件按需加载，首屏只拉取双检测页所在 chunk
const About = () => import('../views/About.vue')
const APISet = () => import('../views/APISet.vue')
const DualReview = () => import('../views/DualReview.vue')

const routes = [
  {
    path: '/',
    name: 'Home',
    redirect: '/dual-review'
  },
  {
    path: '/dual-review',
    name: 'DualReview',
    component: DualReview
  },
  {
    path: '/api',
    name: 'APISet',
    component: APISet
  },
  {
    path: '/about',
    name: 'About',
    component: About
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
