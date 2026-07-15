/**
 * 文档加载工具
 * 用于加载 YAML 导航配置和 Markdown 文件
 */
import yaml from 'js-yaml'

// 动态导入所有用户文档 markdown 文件
const userMarkdownModules = import.meta.glob(
  '/src/docs-content/user/**/*.md',
  { query: '?raw', import: 'default', eager: false }
)

// 动态导入所有开发者文档 markdown 文件
const developerMarkdownModules = import.meta.glob(
  '/src/views/docs/developer/**/*.md',
  { query: '?raw', import: 'default', eager: false }
)

// 动态导入导航配置文件
const navigationModules = import.meta.glob(
  ['/src/docs-content/**/_navigation.yaml', '/src/views/docs/**/_navigation.yaml'],
  { query: '?raw', import: 'default', eager: true }
)

/**
 * 加载导航配置
 * @param {string} docType - 'user' 或 'developer'
 * @returns {Promise<object>} 导航配置对象
 */
export async function loadNavigation(docType: any) {
  const path = docType === 'user'
    ? '/src/docs-content/user/_navigation.yaml'
    : `/src/views/docs/${docType}/_navigation.yaml`
  const yamlContent = (navigationModules as any)[path]

  if (!yamlContent) {
    console.error(`Navigation file not found: ${path}`)
    return { sections: [] }
  }

  try {
    return yaml.load(yamlContent)
  } catch (error) {
    console.error(`Failed to parse navigation YAML: ${error}`)
    return { sections: [] }
  }
}

/**
 * 加载 Markdown 文件内容
 * @param {string} docType - 'user' 或 'developer'
 * @param {string} filePath - 相对于 docType 目录的文件路径
 * @returns {Promise<string>} Markdown 内容
 */
export async function loadMarkdown(docType: any, filePath: any) {
  const fullPath = docType === 'user'
    ? `/src/docs-content/user/${filePath}`
    : `/src/views/docs/${docType}/${filePath}`
  const modules = docType === 'user' ? userMarkdownModules : developerMarkdownModules

  const loader = (modules as any)[fullPath]
  if (!loader) {
    console.error(`Markdown file not found: ${fullPath}`)
    return `# 文档不存在\n\n请检查文件路径: ${filePath}`
  }

  try {
    return await loader()
  } catch (error: any) {
    console.error(`Failed to load markdown: ${error}`)
    return `# 加载失败\n\n${error.message}`
  }
}

/**
 * 根据路由路径查找对应的文件路径
 * @param {object} navigation - 导航配置
 * @param {string} routePath - 路由路径
 * @returns {string|null} 文件路径
 */
export function findFileByPath(navigation: any, routePath: any) {
  for (const section of navigation.sections) {
    if (section.children) {
      for (const item of section.children) {
        if (item.path === routePath && item.file) {
          return item.file
        }
        // 检查子级
        if (item.children) {
          for (const child of item.children) {
            if (child.path === routePath && child.file) {
              return child.file
            }
          }
        }
      }
    }
  }
  return null
}

/**
 * 获取默认文档路径（第一个文档）
 * @param {object} navigation - 导航配置
 * @returns {object|null} { path, file }
 */
export function getDefaultDoc(navigation: any) {
  for (const section of navigation.sections) {
    if (section.children && section.children.length > 0) {
      const firstChild = section.children[0]
      if (firstChild.file) {
        return { path: firstChild.path, file: firstChild.file }
      }
      // 检查子级
      if (firstChild.children && firstChild.children.length > 0) {
        const firstGrandChild = firstChild.children[0]
        if (firstGrandChild.file) {
          return { path: firstGrandChild.path, file: firstGrandChild.file }
        }
      }
    }
  }
  return null
}

/**
 * 扁平化导航项以便搜索
 * @param {object} navigation - 导航配置
 * @returns {Array} 扁平化的导航项数组
 */
export function flattenNavigation(navigation: any) {
  const items: any[] = []

  const flatten = (nodes: any, parentPath = '') => {
    for (const node of nodes) {
      if (node.file) {
        items.push({
          title: node.title,
          path: node.path,
          file: node.file
        })
      }
      if (node.children) {
        flatten(node.children, node.path)
      }
    }
  }

  if (navigation.sections) {
    flatten(navigation.sections)
  }

  return items
}
