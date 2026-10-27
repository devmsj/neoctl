import { createApp } from 'vue'
import './style.css'
import './neo-brutalist-soft.css'
import './chrome-theme.css'
import 'katex/dist/katex.min.css'
import './rich-text.css'
import './task-chrome.css'
import './context-chrome.css'
import './settings-chrome.css'
import './composer-chrome.css'
import './composer-dialogs.css'
import './scrollbars.css'
import App from './AuthGate.vue'

createApp(App).mount('#app')

import './workspace-pages.css'
import './workspace-layout.css'
import './attachments.css'
import { isDesktop } from './local-resources.mjs'
document.documentElement.dataset.desktop = String(isDesktop())

// Only the desktop shell suppresses the embedded browser's native context menu.
document.addEventListener('contextmenu', event => {
  if (isDesktop()) event.preventDefault()
})
