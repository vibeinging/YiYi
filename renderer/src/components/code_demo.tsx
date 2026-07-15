import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// 获取store和router

interface CodeDemoProps {
  name?: string
}

// 导出给父元素使用的实例方法（对应 defineExpose）
export interface CodeDemoHandle {
  helloFunc: () => void
}

const CodeDemo = forwardRef<CodeDemoHandle, CodeDemoProps>(function CodeDemo(
  { name = 'fai' },
  ref
) {
  // reactive({ levelList: null }) → useState
  const [levelList] = useState<any>(null)

  // computed(() => 'value')
  const routes = useMemo(() => 'value', [])

  // router（React Router 跳转）
  const navigate = useNavigate()

  // watch(() => props.name, ..., { immediate: true })
  // 旧/新参数顺序与原文件保持一致（原代码 callback 体为空）
  const prevNameRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const oldValue = prevNameRef.current
    const newValue = name
    prevNameRef.current = name
    // 原 callback 体为空，保持空实现
    void oldValue
    void newValue
  }, [name])

  // onMounted
  useEffect(() => {
    // 原 onMounted 体为空
  }, [])

  const helloFunc = () => {}

  // 导出给父元素使用（defineExpose）
  useImperativeHandle(ref, () => ({ helloFunc }), [])

  // routes / levelList / navigate 派生但原模板未使用，保留以对齐源逻辑
  void routes
  void levelList
  void navigate

  return <div>vue3推荐模板可以集成在你们的vscode或webstorm中，有助于快速开发</div>
})

export default CodeDemo
