export function formatModelDisplay(model, reasoningEffort) {
  const name = String(model || '').trim()
  if (!name) return '模型未配置'
  const effort = String(reasoningEffort || '').trim()
  return effort ? `${name}（${effort}）` : name
}
