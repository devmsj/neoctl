import { createApp } from 'vue'
import ControlSessionViewer from './ControlSessionViewer.vue'

// Independent entry: no Web workspace, engine, runtime, tools or command router.
createApp(ControlSessionViewer).mount('#app')
