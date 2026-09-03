export const XHS_PAYLOAD_FIELDS = ['title', 'body', 'interaction', 'hashtags', 'images', 'review'];
export const XHS_IMAGE_FIELDS = ['url', 'caption', 'overlay', 'note'];

export const XHS_ARTIFACT_EDITOR_HINT = `
【小红书编辑器输出契约】
当你已经产出一篇完整、可发布的小红书笔记时，必须调用 open_xhs_artifact_editor，不能用普通 Markdown、JSON 代码块或自然语言代替工具调用。

工具参数只能是以下结构，字段名、层级和类型必须完全一致：
{"payload":{"title":"发布标题","body":"仅发布正文","interaction":"可选互动/活动规则，无则为空字符串","hashtags":["#话题1","#话题2"],"images":[{"url":"真实图片 URL、/api/ 路径或绝对本地路径；尚未生成则为空字符串","caption":"画面内容说明","overlay":"图片上实际显示的文字，无则为空字符串","note":"拍摄/生成/排版备注，无则为空字符串"}],"review":"内部审核备注，无则为空字符串"}}

严格边界：
1. payload 必须且只能包含 title、body、interaction、hashtags、images、review 六个字段，六个字段都必须提供。
2. title 只放最终发布标题；body 只放最终发布正文，不能重复 title，不能包含“标题/正文/配图/标签/审核”等章节标题，不能包含话题标签、图片方案、审核意见、JSON 或 Markdown 围栏。
3. hashtags 必须是字符串数组，每项是一个以 # 开头的话题；话题不能再次写入 body。
4. images 必须是数组且至少一项。每项必须且只能包含 url、caption、overlay、note 四个字符串字段，不能传字符串、Markdown 图片、旧字段名或嵌套对象。
5. 已生成/已上传图片：把图片工具返回的真实 URL 或绝对路径原样放入 images[].url。未生成图片：url 必须为 ""，将配图方案写入 caption/note。严禁把提示词、图片描述、文件 id 或 Markdown 图片语法放入 url。
6. interaction 和 review 没有内容时传 ""，不得省略。不要把工具参数再输出成正文。
7. 修改已有编辑器前，先调用 read_xhs_artifact 读取最新内容，保留用户编辑，再用相同 artifact_id 和完整 payload 调用 open_xhs_artifact_editor。
`.trim();

export const XHS_ARTIFACT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    artifact_id: {
      type: 'string',
      description: '已有编辑器 id。仅修改时提供；修改前必须先调用 read_xhs_artifact。',
    },
    payload: {
      type: 'object',
      description: '完整的小红书编辑器数据。只能使用声明的六个字段，不接受 Markdown、内容块或旧字段名。',
      properties: {
        title: {
          type: 'string',
          description: '最终发布标题。只放标题，不含正文、封面文案备选、话题或其他章节。',
        },
        body: {
          type: 'string',
          description: '最终发布正文。不得重复标题，不得含话题、配图方案、审核意见、JSON、Markdown 围栏或“正文”等章节标题。',
        },
        interaction: {
          type: 'string',
          description: '单独展示的互动文案或活动规则；没有时必须传空字符串。',
        },
        hashtags: {
          type: 'array',
          description: '话题数组。每项是一个以 # 开头的字符串；不得把话题写入正文。',
          items: { type: 'string' },
        },
        images: {
          type: 'array',
          description: '有序配图数组，至少一项。每项只能是 url、caption、overlay、note 四个字符串字段。',
          items: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: '真实 http(s) URL、/api/ URL 或绝对本地图片路径；图片尚未创建时传空字符串。不得放描述或提示词。',
              },
              caption: {
                type: 'string',
                description: '画面内容说明。不是正文，也不是图片 URL。',
              },
              overlay: {
                type: 'string',
                description: '图片上实际显示的文字；没有时传空字符串。',
              },
              note: {
                type: 'string',
                description: '内部拍摄、生成、布局或设计备注；没有时传空字符串。',
              },
            },
            required: XHS_IMAGE_FIELDS,
            additionalProperties: false,
          },
        },
        review: {
          type: 'string',
          description: '内部合规/风格审核备注；没有时必须传空字符串，绝不能写入正文。',
        },
      },
      required: XHS_PAYLOAD_FIELDS,
      additionalProperties: false,
    },
  },
  required: ['payload'],
  additionalProperties: false,
};

export function parseXhsArtifactToolOutput(value) {
  const parsed = typeof value === 'string' ? parseFirstJsonObject(value) : value;
  const artifact = parsed?.artifact || parsed?.output?.artifact || parsed?.result?.artifact;
  return isCompleteXhsArtifact(artifact) ? artifact : null;
}

export function selectNewestXhsArtifact(current, candidate) {
  if (!isCompleteXhsArtifact(candidate)) return isCompleteXhsArtifact(current) ? current : null;
  if (!isCompleteXhsArtifact(current)) return candidate;
  if (String(current.id) !== String(candidate.id)) return candidate;
  const currentUpdatedAt = Number(current.updatedAt || current.createdAt || 0);
  const candidateUpdatedAt = Number(candidate.updatedAt || candidate.createdAt || 0);
  return candidateUpdatedAt > currentUpdatedAt ? candidate : current;
}

function isCompleteXhsArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !String(value.id || '').trim()) return false;
  const payload = value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!XHS_PAYLOAD_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(payload, field))) return false;
  if (typeof payload.title !== 'string' || typeof payload.body !== 'string' || typeof payload.interaction !== 'string' || typeof payload.review !== 'string') return false;
  if (!payload.title.trim() || !payload.body.trim() || !Array.isArray(payload.hashtags) || !payload.hashtags.every((tag) => typeof tag === 'string')) return false;
  if (!Array.isArray(payload.images) || !payload.images.length) return false;
  return payload.images.every((image) => image && typeof image === 'object' && !Array.isArray(image)
    && XHS_IMAGE_FIELDS.every((field) => typeof image[field] === 'string'));
}

function parseFirstJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  for (let end = raw.length; end > start; end = raw.lastIndexOf('}', end - 1)) {
    if (end <= start) break;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}
