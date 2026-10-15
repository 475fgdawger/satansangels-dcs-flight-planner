// Just enough Lua to read a DCS mission file: `name = { ... }` table constructors of strings, numbers,
// booleans and nil, as the DCS serializer writes them. Tables keep their text span so a caller can splice
// a replacement into the original text and leave everything else byte for byte.

export type LuaValue = string | number | boolean | null | LuaTable

export interface LuaTable {
  /** Keys as written: strings for ["k"] and bare names, numbers for [1]. */
  map: Map<string | number, LuaValue>
  /** Text span: start at `{`, end just after `}`. */
  start: number
  end: number
}

export const isTable = (v: LuaValue | undefined): v is LuaTable => typeof v === 'object' && v !== null

/** Parses `name = <value>` assignments at the top level of a Lua file. */
export function parseLuaAssignments(src: string): Map<string, LuaValue> {
  const p = new Parser(src)
  const out = new Map<string, LuaValue>()
  p.ws()
  while (p.i < src.length) {
    const name = p.ident()
    p.ws(); p.expect('='); p.ws()
    out.set(name, p.value())
    p.ws()
  }
  return out
}

/** Field of a table by path; undefined when any step is missing. */
export function luaGet(t: LuaValue | undefined, ...path: (string | number)[]): LuaValue | undefined {
  let v: LuaValue | undefined = t
  for (const k of path) {
    if (!isTable(v)) return undefined
    v = v.map.get(k)
  }
  return v
}

/** The array part of a table ([1], [2], ...), in order. */
export function luaList(t: LuaValue | undefined): LuaValue[] {
  if (!isTable(t)) return []
  const out: LuaValue[] = []
  for (let i = 1; t.map.has(i); i++) out.push(t.map.get(i)!)
  return out
}

/** A Lua string literal. */
export function luaString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
}

class Parser {
  i = 0
  constructor(readonly s: string) {}

  fail(what: string): never {
    const line = this.s.slice(0, this.i).split('\n').length
    throw new Error(`Mission file: expected ${what} at line ${line}`)
  }

  ws() {
    const s = this.s
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++
      if (s.startsWith('--', this.i)) {
        const long = /^--\[(=*)\[/.exec(s.slice(this.i, this.i + 20))
        if (long) {
          const close = s.indexOf(`]${long[1]}]`, this.i)
          this.i = close < 0 ? s.length : close + long[1].length + 2
        } else {
          const nl = s.indexOf('\n', this.i)
          this.i = nl < 0 ? s.length : nl + 1
        }
        continue
      }
      return
    }
  }

  expect(c: string) {
    if (this.s[this.i] !== c) this.fail(`"${c}"`)
    this.i++
  }

  ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 256))
    if (!m) this.fail('a name')
    this.i += m[0].length
    return m[0]
  }

  value(): LuaValue {
    const c = this.s[this.i]
    if (c === '{') return this.table()
    if (c === '"' || c === "'") return this.string()
    if (c === '[' && /^\[=*\[/.test(this.s.slice(this.i, this.i + 20))) return this.longString()
    const m = /^(-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|true|false|nil)/.exec(this.s.slice(this.i, this.i + 64))
    if (!m) this.fail('a value')
    this.i += m[0].length
    if (m[0] === 'true') return true
    if (m[0] === 'false') return false
    if (m[0] === 'nil') return null
    return Number(m[0])
  }

  string(): string {
    const q = this.s[this.i++]
    let out = ''
    for (;;) {
      const c = this.s[this.i++]
      if (c === undefined) this.fail('the end of a string')
      if (c === q) return out
      if (c !== '\\') { out += c; continue }
      const e = this.s[this.i++]
      if (e === 'n') out += '\n'
      else if (e === 't') out += '\t'
      else if (e === 'r') out += '\r'
      else if (e === '\n') out += '\n'
      else if (/\d/.test(e)) {
        const m = /^\d{1,3}/.exec(this.s.slice(this.i - 1, this.i + 2))!
        out += String.fromCharCode(Number(m[0]))
        this.i += m[0].length - 1
      } else out += e
    }
  }

  longString(): string {
    const m = /^\[(=*)\[/.exec(this.s.slice(this.i, this.i + 20))!
    const close = this.s.indexOf(`]${m[1]}]`, this.i)
    if (close < 0) this.fail('the end of a long string')
    let body = this.s.slice(this.i + m[0].length, close)
    if (body.startsWith('\n')) body = body.slice(1)
    this.i = close + m[1].length + 2
    return body
  }

  table(): LuaTable {
    const start = this.i
    this.expect('{')
    const map = new Map<string | number, LuaValue>()
    let n = 1
    for (;;) {
      this.ws()
      if (this.s[this.i] === '}') { this.i++; return { map, start, end: this.i } }
      let key: string | number
      if (this.s[this.i] === '[' && !/^\[=*\[/.test(this.s.slice(this.i, this.i + 20))) {
        this.i++; this.ws()
        const k = this.value()
        if (typeof k !== 'string' && typeof k !== 'number') this.fail('a string or number key')
        key = k
        this.ws(); this.expect(']'); this.ws(); this.expect('='); this.ws()
        map.set(key, this.value())
      } else {
        const save = this.i
        const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 256))
        let named = false
        if (id && !['true', 'false', 'nil'].includes(id[0])) {
          this.i += id[0].length; this.ws()
          if (this.s[this.i] === '=' && this.s[this.i + 1] !== '=') { this.i++; this.ws(); map.set(id[0], this.value()); named = true }
          else this.i = save
        }
        if (!named) map.set(n++, this.value())
      }
      this.ws()
      if (this.s[this.i] === ',' || this.s[this.i] === ';') this.i++
      else if (this.s[this.i] !== '}') this.fail('"," or "}"')
    }
  }
}
