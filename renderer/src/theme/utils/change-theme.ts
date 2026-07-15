export const toggleHtmlClass = (className: string) => {
  const supportedThemes = new Set(['base', 'dark', 'lighting', 'china-red', 'yiw-warm'])
  const normalizedTheme = supportedThemes.has(className) ? className : 'yiw-warm'
  document.querySelectorAll('html')[0].className = normalizedTheme
}
