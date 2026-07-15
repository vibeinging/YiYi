import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

const resolvePort = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback
}

// 对齐原 Vue 工程：alias '@' → src，dev 代理走 env，svg sprite 走 icons 目录
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devPort = resolvePort(env.VITE_APP_DEV_PORT || env.VITE_DEV_PORT, 57131)
  const pathSrc = path.resolve(__dirname, 'src')

  return {
    base: mode === 'desktop' ? './' : (env.VITE_BASE_PATH || '/'),
    clearScreen: false,
    server: {
      port: devPort,
      strictPort: true,
      open: false,
      host: true,
      // dev 联调:把 VITE_PROXY_BASE_URL(如 /api) 代理到运行的后端 VITE_PROXY_URL。
      // 后端路由本身就挂在 /api/* 下,故**保留路径前缀**(不 rewrite 去掉),否则会把 /api/user/login 改成 /user/login。
      proxy: env.VITE_PROXY_BASE_URL
        ? {
            [env.VITE_PROXY_BASE_URL]: {
              target: env.VITE_PROXY_URL,
              changeOrigin: true,
              // 若某后端确实不带 /api 前缀,设 VITE_PROXY_STRIP=1 再去掉前缀
              ...(env.VITE_PROXY_STRIP === '1'
                ? { rewrite: (p: string) => p.replace(new RegExp(`^${env.VITE_PROXY_BASE_URL}`), '') }
                : {})
            }
          }
        : undefined
    },
    plugins: [
      react(),
      // 复用原 src/icons/common + nav-bar 下的 svg，sprite 注入方式与 Vue 版一致：#icon-[dir]-[name]
      createSvgIconsPlugin({
        iconDirs: [path.resolve(pathSrc, 'icons/common'), path.resolve(pathSrc, 'icons/nav-bar')],
        symbolId: 'icon-[dir]-[name]'
      })
    ],
    resolve: {
      alias: {
        '@': pathSrc,
        // html2pdf.js 包名带 .js 后缀导致解析失败，显式指向 bundle
        'html2pdf.js': 'html2pdf.js/dist/html2pdf.bundle.min.js'
      }
    },
    build: {
      chunkSizeWarningLimit: 10000,
      assetsDir: 'static/assets',
      rollupOptions: {
        output: {
          chunkFileNames: 'static/js/[name]-[hash].js',
          entryFileNames: 'static/js/[name]-[hash].js',
          assetFileNames: 'static/[ext]/[name]-[hash].[ext]'
        }
      }
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
          silenceDeprecations: ['legacy-js-api'],
          // 对齐原工程:把 responsive.scss 的 @include mobile/tablet 等 mixin 全局注入每个 scss 入口
          additionalData: `@use "${pathSrc.replace(/\\\\/g, '/')}/styles/responsive.scss" as *;\n`
        }
      }
    }
  }
})
