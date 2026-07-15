import { createTheme, type MantineColorsTuple } from '@mantine/core'

// YiW 默认主题。与 Element Plus 和工作台共用同一套深绿主色。
const yiwWarm: MantineColorsTuple = [
  '#edf3ef',
  '#dce8e2',
  '#bad3c8',
  '#91b8a8',
  '#669b87',
  '#417c69',
  '#2f6f60',
  '#276354',
  '#17483e',
  '#123b33'
]

export const mantineTheme = createTheme({
  primaryColor: 'yiw',
  colors: {
    yiw: yiwWarm
  },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
  defaultRadius: 'md',
  cursorType: 'pointer'
})
