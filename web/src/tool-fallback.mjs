// Complete translation units with named parameters.
const fallbackMessages = {
  'file.read': '读取 {path}', 'file.readFrom': '从第 {line} 行读取 {path}',
  'file.list': '列出 {path} 中的文件', 'file.listCurrent': '列出当前工作目录中的文件',
  'file.search': '搜索“{query}”', 'file.searchIn': '在 {path} 中搜索“{query}”',
  'file.write': '写入 {path}', 'file.edit': '修改 {path}',
  'terminal.run': '执行 {command}', 'terminal.poll': '读取终端 {id} 的输出',
  'terminal.input': '向终端 {id} 发送输入', 'terminal.interrupt': '中断终端 {id} 的当前命令',
  'terminal.terminate': '终止终端 {id}', 'terminal.kill': '强制终止终端 {id}',
  'web.search': '搜索网页“{query}”',
  'image.generate': '生成图片“{name}”', 'image.edit': '编辑图片“{name}”',
  'image.inspect': '查看图片 {ref}', 'image.inspectMany': '查看 {count} 张图片', 'image.list': '列出会话中的图片',
  'image.note': '记录图片 {ref} 的信息', 'image.noteMany': '记录 {count} 张图片的信息',
  'plan.title': '更新计划“{title}”', 'plan.count': '更新 {count} 项计划',
  'feedback.title': '提交建议“{title}”',
  'agent.runName': '启动子任务 {name}', 'agent.runPrompt': '启动子任务：{prompt}',
  'agent.output': '读取子任务 {id} 的输出', 'agent.list': '查看当前会话的子任务',
  'agent.get': '查看子任务 {id}', 'agent.stop': '停止子任务 {id}',
  'agent.message': '向 {target} 发送消息', 'agent.resume': '恢复子任务 {id}',
  'agent.reportDraft': '提交子任务报告草稿', 'agent.reportCompleted': '提交子任务完成报告',
  'agent.reportIncomplete': '提交子任务未完成报告',
  'plugin.downloadOne': '提供文件 {file} 的下载链接', 'plugin.downloadMany': '提供 {count} 个文件的下载链接',
  'plugin.generic': '调用插件工具 {name}', 'tool.generic': '调用工具 {name}'
};
function fallbackText(key, params = {}, messages = fallbackMessages) {
  return (messages[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}
const tidy = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const leaf = value => tidy(value).replace(/\\/g, '/').split('/').pop();
function fallbackDescriptor(tool, input = {}) {
  const p = input || {}, text = key => tidy(p[key]);
  const d = (key, params = {}) => ({key, params});
  const generic = () => d('tool.generic', {name: tool});
  switch (tool) {
    case 'file_read': return text('path') ? (p.offset > 1 ? d('file.readFrom', {path:p.path, line:p.offset}) : d('file.read', {path:p.path})) : generic();
    case 'file_list': return text('path') ? d('file.list', {path:p.path}) : d('file.listCurrent');
    case 'file_search': return text('query') ? (text('path') ? d('file.searchIn',{path:p.path,query:p.query}) : d('file.search',{query:p.query})) : generic();
    case 'file_write': case 'file_edit': return text('path') ? d(tool === 'file_write' ? 'file.write':'file.edit',{path:p.path}) : generic();
    case 'terminal_run': return text('cmd') ? d('terminal.run',{command:tidy(p.cmd)}) : generic();
    case 'terminal_control': {
      if (!text('session_id')) return generic();
      const signal = ['interrupt','terminate','kill'].includes(p.signal) ? p.signal : null;
      return d('terminal.'+(signal || (typeof p.chars === 'string' && p.chars.length ? 'input':'poll')),{id:p.session_id});
    }
    case 'web_search': return text('query') ? d('web.search',{query:p.query}) : generic();
    case 'image_create': return text('semanticName') ? d(p.mode==='edit'?'image.edit':'image.generate',{name:p.semanticName}) : generic();
    case 'image_inspect': {
      if(p.mode==='list') return d('image.list');
      const refs=Array.isArray(p.imageRefs)?p.imageRefs.filter(tidy):[];
      return refs.length>1 ? d('image.inspectMany',{count:refs.length}) : refs.length ? d('image.inspect',{ref:refs[0]}) : generic();
    }
    case 'image_note': {
      const refs=Array.isArray(p.notes)&&p.notes.length?p.notes.map(n=>n.imageRef).filter(tidy):text('imageRef')?[p.imageRef]:[];
      return refs.length>1?d('image.noteMany',{count:refs.length}):refs.length?d('image.note',{ref:refs[0]}):generic();
    }
    case 'plan_update': return text('title')?d('plan.title',{title:p.title}):Array.isArray(p.items)?d('plan.count',{count:p.items.length}):generic();
    case 'framework_feedback': return text('title')?d('feedback.title',{title:p.title}):generic();
    case 'subagent_run': return text('name')?d('agent.runName',{name:p.name}):text('prompt')?d('agent.runPrompt',{prompt:tidy(p.prompt)}):generic();
    case 'subagent_list': return d('agent.list');
    case 'subagent_output': case 'subagent_get': case 'subagent_stop': case 'subagent_resume':
      return text('task_id')?d('agent.'+tool.slice(9),{id:p.task_id}):generic();
    case 'subagent_message': return text('target')?d('agent.message',{target:p.target}):generic();
    case 'subagent_report': {
      const status=p.status || 'draft';
      return d(status==='completed'?'agent.reportCompleted':status==='incomplete'?'agent.reportIncomplete':'agent.reportDraft');
    }
    case 'expose_downloads': {
      const paths=Array.isArray(p.paths)?p.paths.filter(tidy):[];
      return paths.length>1?d('plugin.downloadMany',{count:paths.length}):paths.length?d('plugin.downloadOne',{file:leaf(paths[0])}):d('plugin.generic',{name:tool});
    }
    default: return d('plugin.generic',{name:tool});
  }
}

export { fallbackMessages, fallbackText, fallbackDescriptor };
