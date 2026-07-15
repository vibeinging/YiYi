const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const iconsDir = path.join(root, 'electron', 'icons')
const source = path.join(iconsDir, 'yiw-icon.svg')

const pngOutputs = new Map([
  ['32x32.png', 32],
  ['64x64.png', 64],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['StoreLogo.png', 50],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310],
  ['icon.png', 512],
])

function pngAt(image, size) {
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

function writeIco(file, image, sizes) {
  const images = sizes.map((size) => ({ size, data: pngAt(image, size) }))
  const headerSize = 6 + images.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let offset = headerSize
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    header.writeUInt8(size === 256 ? 0 : size, entry)
    header.writeUInt8(size === 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })

  fs.writeFileSync(file, Buffer.concat([header, ...images.map(({ data }) => data)]))
}

function writeIcns(image) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yiw-iconset-'))
  const iconset = path.join(tempDir, 'YiW.iconset')
  fs.mkdirSync(iconset)
  const outputs = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]

  try {
    for (const [name, size] of outputs) {
      fs.writeFileSync(path.join(iconset, name), pngAt(image, size))
    }
    execFileSync('/usr/bin/iconutil', [
      '-c',
      'icns',
      '-o',
      path.join(iconsDir, 'icon.icns'),
      iconset,
    ])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function renderSvg() {
  const svg = fs.readFileSync(source, 'utf8')
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })
  const html = `<!doctype html><style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden;background:transparent}svg{display:block;width:1024px;height:1024px}</style>${svg}`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  window.destroy()
  return image
}

app.whenReady().then(async () => {
  const image = await renderSvg()

  for (const [name, size] of pngOutputs) {
    fs.writeFileSync(path.join(iconsDir, name), pngAt(image, size))
  }

  writeIcns(image)
  writeIco(path.join(iconsDir, 'icon.ico'), image, [16, 24, 32, 48, 64, 128, 256])
  writeIco(path.join(root, 'renderer', 'public', 'favicon.ico'), image, [16, 32, 48, 64])
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
