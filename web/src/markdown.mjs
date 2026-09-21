import { Marked } from 'marked'

// CommonMark rejects a closing ** after punctuation when CJK text follows it.
// Support this prose convention at the inline-token layer, not by rewriting
// messages: code blocks/spans, HTML attributes and link destinations stay literal.
export const marked = new Marked({
  extensions: [{
    name: 'cjkStrong',
    level: 'inline',
    start(source) { return source.indexOf('**') },
    tokenizer(source) {
      const match = /^\*\*([^*\r\n]+(?![\\*])[\p{P}\p{S}])\*\*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u.exec(source)
      if (!match || /^\s/u.test(match[1]) || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(match[1])) return
      return { type: 'strong', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) }
    },
  }],
})
