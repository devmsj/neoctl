<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  artifact: {
    type: Object,
    required: true,
  },
  sessionId: {
    type: String,
    default: '',
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

watch(() => [props.artifact?.id, props.artifact?.updatedAt], () => {
  Object.assign(draft, createDraft(props.artifact))
  activeImageIndex.value = 0
  void loadLatestArtifact()
})

onMounted(() => { void loadLatestArtifact() })

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
  const payload = artifact?.payload || {}
  return {
    id: artifact?.id || '',
    title: typeof payload.title === 'string' ? payload.title : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    interaction: typeof payload.interaction === 'string' ? payload.interaction : '',
    hashtags: Array.isArray(payload.hashtags) ? [...payload.hashtags] : [],
    images: Array.isArray(payload.images) ? payload.images.map((image) => ({
      url: typeof image?.url === 'string' ? image.url : '',
      caption: typeof image?.caption === 'string' ? image.caption : '',
      overlay: typeof image?.overlay === 'string' ? image.overlay : '',
      note: typeof image?.note === 'string' ? image.note : '',
    })) : [],
    review: typeof payload.review === 'string' ? payload.review : '',
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
  return { url: '', caption: `配图 ${index + 1}`, overlay: '', note: '' }
}

function scheduleSave() {
  if (isReadonly.value) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 450)
}

async function saveNow() {
  if (!draft.id || isReadonly.value) return
  try {
    const res = await fetch(artifactApiUrl(draft.id), {
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

async function loadLatestArtifact() {
  const id = String(props.artifact?.id || '')
  if (!id) return
  try {
    const res = await fetch(artifactApiUrl(id))
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.error || !body?.artifact) throw new Error(body?.error || `load ${res.status}`)
    if (String(props.artifact?.id || '') !== id) return
    const currentUpdatedAt = Number(props.artifact?.updatedAt || props.artifact?.createdAt || 0)
    const latestUpdatedAt = Number(body.artifact.updatedAt || body.artifact.createdAt || 0)
    if (latestUpdatedAt <= currentUpdatedAt) return
    Object.assign(draft, createDraft(body.artifact))
    emit('saved', body.artifact)
  } catch (error) {
    emit('error', error.message || String(error))
  }
}

function artifactApiUrl(id) {
  const url = new URL(`/api/xhs-artifacts/${encodeURIComponent(id)}`, window.location.origin)
  if (props.sessionId) url.searchParams.set('sessionId', props.sessionId)
  return `${url.pathname}${url.search}`
}

function normalizeTags(value) {
  const text = String(value || '')
  return [...new Set(text.split(/[\s,，、]+/).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith('#') ? tag : `#${tag}`))]
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
