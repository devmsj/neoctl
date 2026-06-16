<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  artifact: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits(['saved', 'error'])

const MODE_KEY = 'neoctl-web.xhsArtifactEditor.mode'
const mode = ref(localStorage.getItem(MODE_KEY) || 'readonly')
const fullscreen = ref(false)
const activeImageIndex = ref(0)
const fileInput = ref(null)
const uploadTargetIndex = ref(-1)
const draft = reactive(createDraft(props.artifact))
let saveTimer = 0

const tagText = computed({
  get: () => draft.hashtags.join(' '),
  set: (value) => {
    draft.hashtags = normalizeTags(value)
    scheduleSave()
  },
})

const isReadonly = computed(() => mode.value === 'readonly')
const isEditOnly = computed(() => mode.value === 'edit')
const activeImage = computed(() => draft.images[activeImageIndex.value] || null)

watch(() => props.artifact?.id, () => {
  Object.assign(draft, createDraft(props.artifact))
  activeImageIndex.value = 0
})

function setMode(nextMode) {
  mode.value = nextMode
  localStorage.setItem(MODE_KEY, nextMode)
}

function setActiveImage(index) {
  if (!draft.images.length) {
    activeImageIndex.value = 0
    return
  }
  activeImageIndex.value = Math.max(0, Math.min(index, draft.images.length - 1))
}

function stepImage(direction) {
  if (!draft.images.length) return
  activeImageIndex.value = (activeImageIndex.value + direction + draft.images.length) % draft.images.length
}

function createDraft(artifact) {
  const payload = normalizePayload(artifact?.payload || parsePayload(artifact?.content))
  return {
    id: artifact?.id || '',
    title: firstText(payload.title, artifact?.title),
    body: richText(payload.body),
    interaction: interactionText(payload.interaction),
    hashtags: payload.hashtags || [],
    images: payload.images?.length ? payload.images : [],
    review: richText(payload.review),
  }
}

function updateField(field, value) {
  if (isReadonly.value) return
  draft[field] = value
  scheduleSave()
}

function updateImage(index, field, value) {
  if (isReadonly.value || !draft.images[index]) return
  draft.images[index][field] = value
  scheduleSave()
}

function addImage() {
  if (isReadonly.value) return
  draft.images.push(createEmptyImage(draft.images.length))
  scheduleSave()
}

function removeImage(index) {
  if (isReadonly.value) return
  draft.images.splice(index, 1)
  setActiveImage(activeImageIndex.value)
  scheduleSave()
}

function clearImage(index) {
  if (isReadonly.value || !draft.images[index]) return
  draft.images[index].url = ''
  scheduleSave()
}

function openUploader(index = -1) {
  if (isReadonly.value) return
  uploadTargetIndex.value = index
  fileInput.value?.click()
}

async function handleFiles(event) {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  if (!files.length || isReadonly.value) return
  try {
    const images = await Promise.all(files.map(fileToImageViaUpload))
    if (uploadTargetIndex.value >= 0) {
      const target = uploadTargetIndex.value
      draft.images[target] = { ...(draft.images[target] || createEmptyImage(target)), ...images[0] }
      images.slice(1).forEach((image) => draft.images.push({ ...createEmptyImage(draft.images.length), ...image }))
    } else {
      images.forEach((image) => draft.images.push({ ...createEmptyImage(draft.images.length), ...image }))
    }
    scheduleSave()
  } catch (error) {
    emit('error', error.message || String(error))
  }
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({
      url: String(reader.result || ''),
      caption: file.name.replace(/\.[^.]+$/, ''),
      overlay: '',
      note: `本地上传：${file.name}`,
      sourceName: file.name,
    })
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

async function fileToImageViaUpload(file) {
  const dataUrl = await readFileAsDataUrl(file)
  const base64 = dataUrl.replace(/^data:[^,]*,/, '')
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name,
      mimeType: file.type,
      data: base64,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.error || !body?.file?.url) {
    throw new Error(body?.error || `upload ${res.status}`)
  }
  return {
    url: body.file.url,
    caption: file.name.replace(/\.[^.]+$/, ''),
    overlay: '',
    note: file.name,
    sourceName: file.name,
    upload: body.file,
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('image read failed'))
    reader.readAsDataURL(file)
  })
}

function createEmptyImage(index) {
  return { id: `image-${index + 1}`, url: '', caption: `配图 ${index + 1}`, overlay: '', note: '' }
}

function scheduleSave() {
  if (isReadonly.value) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 450)
}

async function saveNow() {
  if (!draft.id || isReadonly.value) return
  try {
    const res = await fetch(`/api/xhs-artifacts/${encodeURIComponent(draft.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        payload: {
          title: draft.title,
          body: draft.body,
          interaction: draft.interaction,
          hashtags: draft.hashtags,
          images: draft.images,
          review: draft.review,
        },
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.error) throw new Error(body.error || `save ${res.status}`)
    emit('saved', body.artifact)
  } catch (error) {
    emit('error', error.message || String(error))
  }
}

function normalizePayload(value) {
  const root = value && typeof value === 'object' ? value : {}
  const payload = root.web_editor_payload || root.post || root.draft || root.payload || root
  const content = payload.content && typeof payload.content === 'object' ? payload.content : {}
  const imageCards = firstImageList(payload.image_cards, payload.images, payload.image_plan, payload.imagePlan, payload.cards, payload.visuals)
  return {
    title: firstText(payload.title, payload.main_title, payload.cover_title, payload.final_title, content.final_title, payload.title_options, content.title_options, payload.titles),
    body: richText(content.body || payload.body || payload.caption || payload.copy || payload.text || payload.main_body),
    interaction: interactionText(payload.interaction || payload.rules || payload.activity_rules || payload.cta || payload.call_to_action),
    hashtags: normalizeTags(content.hashtags || payload.hashtags || payload.tags || payload.topics),
    images: normalizeImages(imageCards),
    review: richText(payload.review || payload.check || payload.self_check || payload.safety_check),
  }
}

function parsePayload(content) {
  const parsed = parseFirstJsonObject(content)
  if (parsed && typeof parsed === 'object') return parsed
  const text = String(content || '')
  return {
    title: markdownSection(text, ['标题', '主标题', '小红书标题']),
    body: markdownSection(text, ['正文', '笔记正文', '发布文案']),
    images: markdownSection(text, ['配图建议', '配图', '图片方案', 'image_cards']),
    interaction: markdownSection(text, ['互动/活动规则', '互动', '活动规则']),
    hashtags: markdownSection(text, ['话题标签', '标签', 'hashtags']),
    review: markdownSection(text, ['品牌词与风格自检', '自检', 'review']),
  }
}

function parseFirstJsonObject(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  if (start < 0) return null
  for (let end = raw.length; end > start; end = raw.lastIndexOf('}', end - 1)) {
    if (end <= start) break
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

function normalizeImages(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n/).filter(Boolean)
  return list.map((item, index) => {
    if (item && typeof item === 'object') {
      return {
        id: firstText(item.id, item.key, `image-${index + 1}`),
        url: safeImageUrl(item.url, item.src, item.imageUrl, item.image_url, item.preview_url, item.previewUrl, item.local_path, item.path),
        caption: firstText(item.caption, item.title, item.role, item.scene, item.description, item.text, item.visual, item.visual_brief, item.shot, item.copy, `配图 ${index + 1}`),
        overlay: firstText(item.overlay, item.overlay_text?.main, item.overlay_text?.sub, item.overlay_text, item.cover_text, item.key_text, item.headline),
        note: richText(item.note || item.direction || item.prompt || item.detail || item.layout || item.frame || item.visual_brief || item.design_notes || item.replace_instruction),
      }
    }
    const text = String(item || '').replace(/^\d+[.)、\s-]*/, '').trim()
    return { ...createEmptyImage(index), caption: text || `配图 ${index + 1}` }
  })
}

function firstImageList(...values) {
  for (const value of values) {
    const images = normalizeImages(value)
    if (images.some(hasUsefulImageInfo)) return value
  }
  return values.find((value) => Array.isArray(value) && value.length) || values.find(Boolean)
}

function hasUsefulImageInfo(image) {
  return Boolean(image.url || image.caption || image.overlay || image.note)
}

function safeImageUrl(...values) {
  const url = firstText(...values)
  if (!url || /^data:/i.test(url)) return ''
  if (/^(?:https?:|blob:|\/api\/)/i.test(url)) return url
  if (isLocalFilePath(url)) return `/api/local-images/${encodeURIComponent(btoa(unescape(encodeURIComponent(url))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''))}`
  return url
}

function isLocalFilePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function normalizeTags(value) {
  const text = Array.isArray(value) ? value.map(asText).join(' ') : asText(value)
  return [...new Set(text.split(/[\s,，、]+/).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith('#') ? tag : `#${tag}`))]
}

function interactionText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return cleanInteractionLines(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return ''
  if (Array.isArray(value)) return cleanInteractionLines(value.map(interactionText).filter(Boolean).join('\n'))
  if (typeof value === 'object') {
    return cleanInteractionLines([
      value.type,
      value.action_text,
      value.activity_time,
      value.prize,
      value.winner_count,
      value.claim_note,
      value.risk_note,
      value.note,
      value.description,
      value.text,
      value.content,
    ].map(richText).filter(Boolean).join('\n'))
  }
  return cleanInteractionLines(String(value))
}

function cleanInteractionLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:true|false|未设置|无|none|null|undefined)$/i.test(line))
    .join('\n')
}

function markdownSection(text, headings) {
  for (const heading of headings) {
    const match = new RegExp(`(?:^|\\n)#{1,4}\\s*${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s+|$)`, 'i').exec(String(text || ''))
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return ''
}

function firstText(...values) {
  for (const value of values) {
    const text = asText(value)
    if (text) return text
  }
  return ''
}

function richText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(richText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    const preferred = firstText(value.title, value.caption, value.text, value.content, value.description, value.scene, value.name)
    if (preferred) return preferred
    return Object.values(value).map(richText).filter(Boolean).join('\n')
  }
  return String(value).trim()
}

function asText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' / ')
  if (typeof value === 'object') return firstText(value.title, value.caption, value.text, value.content, value.description, value.scene, value.name)
  return String(value).trim()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
</script>

<template>
  <section class="xhs-editor" :class="`xhs-mode-${mode}`">
    <input ref="fileInput" class="xhs-file-input" type="file" accept="image/*" multiple @change="handleFiles" />

    <div class="xhs-editor-head">
      <div class="xhs-editor-title">
        <span>小红书笔记编辑器</span>
        <strong>{{ draft.title || '未命名笔记' }}</strong>
      </div>
      <div class="xhs-editor-actions">
        <div class="xhs-mode-switch" role="tablist" aria-label="编辑模式">
          <button type="button" :class="{ active: mode === 'readonly' }" @click="setMode('readonly')">只读</button>
          <button type="button" :class="{ active: mode === 'edit' }" @click="setMode('edit')">只编辑</button>
          <button type="button" :class="{ active: mode === 'split' }" @click="setMode('split')">左读右编</button>
        </div>
        <button type="button" class="xhs-fullscreen-button" @click="fullscreen = true">全屏</button>
        <code>{{ draft.id }}</code>
      </div>
    </div>

    <div class="xhs-editor-grid" :class="{ 'xhs-grid-edit-only': isEditOnly, 'xhs-grid-readonly': isReadonly }">
      <article v-if="!isEditOnly" class="xhs-phone xhs-preview-panel">
        <div class="xhs-phone-media">
          <template v-if="draft.images.length">
            <figure>
              <img v-if="activeImage?.url" :src="activeImage.url" :alt="activeImage.caption || `配图 ${activeImageIndex + 1}`" />
              <button v-else type="button" class="xhs-slide-placeholder" :disabled="isReadonly" @click="openUploader(activeImageIndex)">
                <span>{{ activeImageIndex + 1 }}</span>
                <strong>{{ activeImage?.overlay || activeImage?.caption || '上传配图' }}</strong>
              </button>
              <button v-if="draft.images.length > 1" type="button" class="xhs-carousel-arrow xhs-carousel-prev" @click="stepImage(-1)">‹</button>
              <button v-if="draft.images.length > 1" type="button" class="xhs-carousel-arrow xhs-carousel-next" @click="stepImage(1)">›</button>
              <div v-if="draft.images.length > 1" class="xhs-carousel-dots">
                <button
                  v-for="(image, index) in draft.images"
                  :key="image.id || index"
                  type="button"
                  :class="{ active: index === activeImageIndex }"
                  @click="setActiveImage(index)"
                ></button>
              </div>
            </figure>
          </template>
          <button v-else type="button" class="xhs-empty-image" :disabled="isReadonly" @click="openUploader(-1)">
            <span>+</span>
            <strong>上传配图</strong>
          </button>
        </div>
        <div class="xhs-phone-body">
          <div class="xhs-readonly-author">
            <span class="xhs-author-avatar">喵</span>
            <span class="xhs-author-name">喵乘舰</span>
            <button type="button">关注</button>
          </div>
          <div class="xhs-readonly-scroll">
            <h3>{{ draft.title || '未命名小红书笔记' }}</h3>
            <p>{{ draft.body || '正文会显示在这里。' }}</p>
            <div v-if="draft.interaction" class="xhs-interaction">{{ draft.interaction }}</div>
            <div class="xhs-tags">
              <span v-for="tag in draft.hashtags" :key="tag">{{ tag }}</span>
            </div>
          </div>
          <div class="xhs-readonly-meta">今天 · 小红书</div>
          <div class="xhs-readonly-actions">
            <span>说点什么...</span>
            <strong>♡ 52</strong>
            <strong>☆ 43</strong>
            <strong>◯ 69</strong>
          </div>
        </div>
      </article>

      <div v-if="!isReadonly" class="xhs-form xhs-edit-panel">
        <label>
          <span>标题</span>
          <input :value="draft.title" @input="updateField('title', $event.target.value)" />
        </label>
        <label>
          <span>正文</span>
          <textarea :value="draft.body" rows="7" @input="updateField('body', $event.target.value)"></textarea>
        </label>
        <label>
          <span>互动/活动规则</span>
          <textarea :value="draft.interaction" rows="3" @input="updateField('interaction', $event.target.value)"></textarea>
        </label>
        <label>
          <span>话题标签</span>
          <input v-model="tagText" />
        </label>

        <div class="xhs-image-panel">
          <div class="xhs-image-panel-head">
            <span>配图</span>
            <div>
              <button type="button" @click="openUploader(-1)">上传图片</button>
              <button type="button" @click="addImage">添加图位</button>
            </div>
          </div>
          <div v-for="(image, index) in draft.images" :key="image.id || index" class="xhs-image-row">
            <button type="button" class="xhs-thumb" @click="openUploader(index)">
              <img v-if="image.url" :src="image.url" :alt="image.caption || `配图 ${index + 1}`" />
              <span v-else>{{ index + 1 }}</span>
            </button>
            <div>
              <input :value="image.caption" placeholder="画面/场景" @input="updateImage(index, 'caption', $event.target.value)" />
              <input :value="image.overlay" placeholder="封面字/图中文字" @input="updateImage(index, 'overlay', $event.target.value)" />
              <input :value="image.note" placeholder="拍摄/设计备注" @input="updateImage(index, 'note', $event.target.value)" />
              <div class="xhs-image-actions">
                <button type="button" @click="openUploader(index)">{{ image.url ? '替换图片' : '上传图片' }}</button>
                <button v-if="image.url" type="button" @click="clearImage(index)">清空图片</button>
                <button type="button" @click="removeImage(index)">删除图位</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="fullscreen" class="xhs-modal-backdrop" @click.self="fullscreen = false">
        <section class="xhs-editor xhs-modal-card" :class="`xhs-mode-${mode}`" role="dialog" aria-modal="true" aria-label="小红书笔记编辑器全屏弹窗">
          <div class="xhs-editor-head">
            <div class="xhs-editor-title">
              <span>小红书笔记编辑器</span>
              <strong>{{ draft.title || '未命名笔记' }}</strong>
            </div>
            <div class="xhs-editor-actions">
              <div class="xhs-mode-switch" role="tablist" aria-label="编辑模式">
                <button type="button" :class="{ active: mode === 'readonly' }" @click="setMode('readonly')">只读</button>
                <button type="button" :class="{ active: mode === 'edit' }" @click="setMode('edit')">只编辑</button>
                <button type="button" :class="{ active: mode === 'split' }" @click="setMode('split')">左读右编</button>
              </div>
              <button type="button" class="xhs-fullscreen-button" @click="fullscreen = false">关闭</button>
              <code>{{ draft.id }}</code>
            </div>
          </div>

          <div class="xhs-editor-grid" :class="{ 'xhs-grid-edit-only': isEditOnly, 'xhs-grid-readonly': isReadonly }">
            <article v-if="!isEditOnly" class="xhs-phone xhs-preview-panel">
              <div class="xhs-phone-media">
                <template v-if="draft.images.length">
                  <figure>
                    <img v-if="activeImage?.url" :src="activeImage.url" :alt="activeImage.caption || `配图 ${activeImageIndex + 1}`" />
                    <button v-else type="button" class="xhs-slide-placeholder" :disabled="isReadonly" @click="openUploader(activeImageIndex)">
                      <span>{{ activeImageIndex + 1 }}</span>
                      <strong>{{ activeImage?.overlay || activeImage?.caption || '上传配图' }}</strong>
                    </button>
                    <button v-if="draft.images.length > 1" type="button" class="xhs-carousel-arrow xhs-carousel-prev" @click="stepImage(-1)">‹</button>
                    <button v-if="draft.images.length > 1" type="button" class="xhs-carousel-arrow xhs-carousel-next" @click="stepImage(1)">›</button>
                    <div v-if="draft.images.length > 1" class="xhs-carousel-dots">
                      <button
                        v-for="(image, index) in draft.images"
                        :key="image.id || index"
                        type="button"
                        :class="{ active: index === activeImageIndex }"
                        @click="setActiveImage(index)"
                      ></button>
                    </div>
                  </figure>
                </template>
                <button v-else type="button" class="xhs-empty-image" :disabled="isReadonly" @click="openUploader(-1)">
                  <span>+</span>
                  <strong>上传配图</strong>
                </button>
              </div>
              <div class="xhs-phone-body">
                <div class="xhs-readonly-author">
                  <span class="xhs-author-avatar">喵</span>
                  <span class="xhs-author-name">喵乘舰</span>
                  <button type="button">关注</button>
                </div>
                <div class="xhs-readonly-scroll">
                  <h3>{{ draft.title || '未命名小红书笔记' }}</h3>
                  <p>{{ draft.body || '正文会显示在这里。' }}</p>
                  <div v-if="draft.interaction" class="xhs-interaction">{{ draft.interaction }}</div>
                  <div class="xhs-tags">
                    <span v-for="tag in draft.hashtags" :key="tag">{{ tag }}</span>
                  </div>
                </div>
                <div class="xhs-readonly-meta">今天 · 小红书</div>
                <div class="xhs-readonly-actions">
                  <span>说点什么...</span>
                  <strong>♡ 52</strong>
                  <strong>☆ 43</strong>
                  <strong>◯ 69</strong>
                </div>
              </div>
            </article>

            <div v-if="!isReadonly" class="xhs-form xhs-edit-panel">
              <label>
                <span>标题</span>
                <input :value="draft.title" @input="updateField('title', $event.target.value)" />
              </label>
              <label>
                <span>正文</span>
                <textarea :value="draft.body" rows="7" @input="updateField('body', $event.target.value)"></textarea>
              </label>
              <label>
                <span>互动/活动规则</span>
                <textarea :value="draft.interaction" rows="3" @input="updateField('interaction', $event.target.value)"></textarea>
              </label>
              <label>
                <span>话题标签</span>
                <input v-model="tagText" />
              </label>

              <div class="xhs-image-panel">
                <div class="xhs-image-panel-head">
                  <span>配图</span>
                  <div>
                    <button type="button" @click="openUploader(-1)">上传图片</button>
                    <button type="button" @click="addImage">添加图位</button>
                  </div>
                </div>
                <div v-for="(image, index) in draft.images" :key="image.id || index" class="xhs-image-row">
                  <button type="button" class="xhs-thumb" @click="openUploader(index)">
                    <img v-if="image.url" :src="image.url" :alt="image.caption || `配图 ${index + 1}`" />
                    <span v-else>{{ index + 1 }}</span>
                  </button>
                  <div>
                    <input :value="image.caption" placeholder="画面/场景" @input="updateImage(index, 'caption', $event.target.value)" />
                    <input :value="image.overlay" placeholder="封面字/图中文字" @input="updateImage(index, 'overlay', $event.target.value)" />
                    <input :value="image.note" placeholder="拍摄/设计备注" @input="updateImage(index, 'note', $event.target.value)" />
                    <div class="xhs-image-actions">
                      <button type="button" @click="openUploader(index)">{{ image.url ? '替换图片' : '上传图片' }}</button>
                      <button v-if="image.url" type="button" @click="clearImage(index)">清空图片</button>
                      <button type="button" @click="removeImage(index)">删除图位</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>
