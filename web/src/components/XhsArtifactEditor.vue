<script setup>
import { computed, reactive, watch } from 'vue'

const props = defineProps({
  artifact: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits(['saved', 'error'])

const draft = reactive(createDraft(props.artifact))
let saveTimer = 0

const tagText = computed({
  get: () => draft.hashtags.join(' '),
  set: (value) => {
    draft.hashtags = normalizeTags(value)
    scheduleSave()
  },
})

watch(() => props.artifact?.id, () => {
  Object.assign(draft, createDraft(props.artifact))
})

function createDraft(artifact) {
  const payload = normalizePayload(artifact?.payload || parsePayload(artifact?.content))
  return {
    id: artifact?.id || '',
    title: asText(payload.title || artifact?.title),
    body: asText(payload.body),
    interaction: asText(payload.interaction),
    hashtags: payload.hashtags || [],
    images: payload.images?.length ? payload.images : [],
    review: asText(payload.review),
  }
}

function updateField(field, value) {
  draft[field] = value
  scheduleSave()
}

function updateImage(index, field, value) {
  draft.images[index][field] = value
  scheduleSave()
}

function addImage() {
  draft.images.push({ id: `image-${draft.images.length + 1}`, url: '', caption: '', overlay: '', note: '' })
  scheduleSave()
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 450)
}

async function saveNow() {
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
  const payload = value && typeof value === 'object' ? value : {}
  return {
    title: firstText(payload.title, payload.main_title, payload.cover_title),
    body: firstText(payload.body, payload.caption, payload.copy, payload.text),
    interaction: firstText(payload.interaction, payload.rules, payload.activity_rules),
    hashtags: normalizeTags(payload.hashtags || payload.tags || payload.topics),
    images: normalizeImages(payload.images || payload.image_plan || payload.imagePlan || payload.image_cards),
    review: firstText(payload.review, payload.check, payload.self_check),
  }
}

function parsePayload(content) {
  const parsed = parseFirstJsonObject(content)
  return parsed && typeof parsed === 'object' ? parsed : {}
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
        id: asText(item.id || item.key || `image-${index + 1}`),
        url: asText(item.url || item.src || item.imageUrl || item.image_url),
        caption: firstText(item.caption, item.title, item.scene, item.description, item.text, `配图 ${index + 1}`),
        overlay: firstText(item.overlay, item.overlay_text, item.cover_text, item.key_text),
        note: firstText(item.note, item.direction, item.prompt, item.detail),
      }
    }
    const text = String(item || '').replace(/^\d+[.)、\s-]*/, '').trim()
    return { id: `image-${index + 1}`, url: '', caption: text || `配图 ${index + 1}`, overlay: '', note: '' }
  })
}

function normalizeTags(value) {
  const text = Array.isArray(value) ? value.join(' ') : asText(value)
  return [...new Set(text.split(/[\s,，、]+/).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith('#') ? tag : `#${tag}`))]
}

function firstText(...values) {
  for (const value of values) {
    const text = asText(value)
    if (text) return text
  }
  return ''
}

function asText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' / ')
  if (typeof value === 'object') return firstText(value.title, value.caption, value.text, value.description, value.scene, value.name)
  return String(value).trim()
}
</script>

<template>
  <section class="xhs-editor">
    <div class="xhs-editor-head">
      <div>
        <span>小红书笔记编辑器</span>
        <strong>{{ draft.title || '未命名笔记' }}</strong>
      </div>
      <code>{{ draft.id }}</code>
    </div>

    <div class="xhs-editor-grid">
      <article class="xhs-phone">
        <div class="xhs-phone-media">
          <template v-if="draft.images.length">
            <figure v-for="(image, index) in draft.images.slice(0, 4)" :key="image.id || index">
              <img v-if="image.url" :src="image.url" :alt="image.caption || `配图 ${index + 1}`" />
              <div v-else>
                <span>{{ index + 1 }}</span>
                <strong>{{ image.overlay || image.caption || '配图' }}</strong>
              </div>
            </figure>
          </template>
          <div v-else class="xhs-empty-image">
            <span>+</span>
            <strong>等待配图</strong>
          </div>
        </div>
        <div class="xhs-phone-body">
          <h3>{{ draft.title || '未命名小红书笔记' }}</h3>
          <p>{{ draft.body || '正文会显示在这里。' }}</p>
          <div v-if="draft.interaction" class="xhs-interaction">{{ draft.interaction }}</div>
          <div class="xhs-tags">
            <span v-for="tag in draft.hashtags" :key="tag">{{ tag }}</span>
          </div>
        </div>
      </article>

      <div class="xhs-form">
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
            <button type="button" @click="addImage">添加图位</button>
          </div>
          <div v-for="(image, index) in draft.images" :key="image.id || index" class="xhs-image-row">
            <div class="xhs-thumb">
              <img v-if="image.url" :src="image.url" :alt="image.caption || `配图 ${index + 1}`" />
              <span v-else>{{ index + 1 }}</span>
            </div>
            <div>
              <input :value="image.url" placeholder="图片 URL" @input="updateImage(index, 'url', $event.target.value)" />
              <input :value="image.caption" placeholder="画面/场景" @input="updateImage(index, 'caption', $event.target.value)" />
              <input :value="image.overlay" placeholder="封面字/图中文字" @input="updateImage(index, 'overlay', $event.target.value)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
