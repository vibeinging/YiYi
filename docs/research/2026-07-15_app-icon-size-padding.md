# App 图标尺寸与留白调研

日期：2026-07-15

## 结论

Apple、Microsoft 和 Electron 都规定了画布尺寸、输出尺寸和小图标适配方式，但没有一条跨平台通用的“必须留白多少百分比”的规则。图标应使用平台模板和网格，并根据实际视觉大小做调整。

修改前，YiW 图标铺得偏满。1024 × 1024 的画布中，黄色底板从 48 到 976，尺寸为 928 × 928：

- 单边透明留白：48 px，占画布 4.69%
- 黄色底板占画布：90.63%
- 中间图形约占画布：60%
- 32 px 图标缩小后，外侧只剩约 1 px 留白

因此，“看起来比别的 App 图标大”的主要原因是黄色底板太靠近画布边缘，不是中间图形本身太大。

## 已采用的修复

图标内容以画布中心为基准整体缩放到原来的 82.4 / 92.8，黄色底板精确调整为 824 × 824：

- 黄色底板范围：`(100, 100)` 到 `(924, 924)`
- 单边透明留白：100 px，约占画布 9.77%
- 中间图形随底板同比例缩放并保持居中
- 使用 `npm run build:icons` 从 SVG 重新生成 PNG、ICNS、ICO 和网页 favicon

## 官方规则

### Apple

- macOS、iOS 和 iPadOS 的主图标画布使用 1024 × 1024。
- 系统会处理图标最终外形和圆角，不应把系统遮罩直接画进导出内容。
- 主要内容应放在中心，避免系统处理后被裁切。
- Apple 建议使用官方模板和网格，但当前规范没有给出统一的固定留白百分比。
- macOS 传统 ICNS 应包含 16、32、128、256、512 及对应 Retina 尺寸。

参考：

- [Apple Human Interface Guidelines - App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Creating your app icon using Icon Composer](https://developer.apple.com/documentation/Xcode/creating-your-app-icon-using-icon-composer)
- [Configuring your app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)

### Windows

- Win32 图标至少应准备 16、24、32、48、256 px。
- Windows 会优先查找与显示目标相同的尺寸；缺少时会缩放更大的图标。
- Windows 图标设计以 48 × 48 网格为主要参考，需要检查小尺寸下的清晰度。
- Windows 同样没有规定所有产品图标必须使用一个固定的留白比例。

参考：

- [Windows app icon construction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)
- [Windows app icon design](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-design)

### Electron

- Electron Builder 推荐 macOS 使用 SVG 或 1024 × 1024 PNG，Windows 使用 SVG 或至少 512 × 512 PNG。
- macOS ICNS 通常需要包含 16 到 1024 的完整尺寸。

参考：

- [Electron Builder - Icons and Images](https://www.electron.build/docs/features/icons-and-images/)

## YiW 当前文件检查

| 文件 | 当前内容 | 结果 |
| --- | --- | --- |
| `electron/icons/yiw-icon.svg` | 1024 × 1024 画布 | 底板 824 × 824，四周 100 px 留白 |
| `electron/icons/icon.png` | 512 × 512 | 可用于 Electron 运行时 |
| `electron/icons/icon.icns` | 16、32、64、128、256、512、1024 | macOS 尺寸完整 |
| `electron/icons/icon.ico` | 16、24、32、48、64、128、256 | Windows 尺寸完整 |

输出尺寸本身完整；新的资源已经统一使用留白调整后的版式。

## 建议

### macOS

建议把黄色底板的透明边距从 4.69% 调到约 9%–10%。在 1024 画布上，可以先用下面的工程取值：

- 黄色底板约 824 × 824
- 位置约为 `(100, 100)`
- 单边透明留白约 100 px

约 10% 是根据平台模板、常见图标视觉大小和当前 YiW 图形做出的建议，不是 Apple 写死的官方数字。最终应放进 Dock 和 Finder，与系统图标并排比较。

### Windows

不建议直接复用留白更多的 macOS 图标，否则任务栏中的图标可能显得偏小。Windows 应单独使用 48 × 48 网格调整，并保留现在完整的 16、24、32、48、256 等尺寸。

### 小尺寸

16、24、32 px 不能只看自动缩放结果。需要单独检查：

- 四块图形之间的缝隙是否还清楚
- 圆角是否糊成一团
- 浅黄色块和黄色底板是否仍有足够对比度
- 任务栏、Dock、Finder 和窗口标题栏中的视觉大小是否一致

## 推荐修改方式

1. 拆成 macOS 和 Windows 两份图标源文件。
2. macOS 版先把底板调整到约 10% 外侧留白。
3. Windows 版继续按 48 × 48 网格调节，不直接套用 macOS 留白。
4. 重新生成 PNG、ICNS 和 ICO。
5. 制作 16、24、32、64、128 px 对比图，并在真实 Dock 和任务栏中检查。
