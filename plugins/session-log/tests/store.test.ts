import { expect, test } from 'claude-code/testing'
import { foldStore, nextId, openTodos, standing, storeLine, typedText } from '../hooks/store'
import type { LogEvent } from '../hooks/store'
import { stateOf } from './world'

const AT = '2026-11-25T10:30:00.000Z'

test('a store folds to the state its events build, in order', async () => {
  const events: LogEvent[] = [
    { t: 'todo.add', at: AT, id: 't1', text: 'a' },
    { t: 'todo.close', at: AT, id: 't1', note: 'done' },
    { t: 'typed', at: AT, text: 'hello' },
    { t: 'did', at: AT, kind: 'push', ref: 'main' },
  ]
  const s = foldStore(events.map(storeLine).join(''))
  expect(s.todos).toEqual([{ id: 't1', at: AT, text: 'a', closed: { at: AT, note: 'done' } }])
  expect(s.typed).toEqual(['hello'])
  expect(s.did).toHaveLength(1)
})

test('a cut last line and a line that is no event are skipped, the rest still folds', async () => {
  const good = storeLine({ t: 'note', at: AT, id: 'n1', text: 'x' })
  const text = `${good}not json\n{"t":"bogus","at":"${AT}"}\n{"t":"note"}\n${good.slice(0, 20)}`
  expect(foldStore(text).entries.map(e => e.id)).toEqual(['n1'])
})

test('a second close of a todo keeps the first close', async () => {
  const s = stateOf({ t: 'todo.add', id: 't1', text: 'a' }, { t: 'todo.close', id: 't1', note: 'first' }, { t: 'todo.close', id: 't1', note: 'second' })
  expect(s.todos[0]?.closed?.note).toBe('first')
  expect(openTodos(s)).toEqual([])
})

test('ids count per kind: t, d, r and n each start at 1 and do not share a counter', async () => {
  const s = stateOf({ t: 'todo.add', id: 't1', text: 'a' }, { t: 'decision', id: 'd1', pick: 'A', over: ['B'], reason: 'r' }, { t: 'decision', id: 'd2', pick: 'A', over: ['B'], reason: 'r' })
  expect([nextId(s, 't'), nextId(s, 'd'), nextId(s, 'r'), nextId(s, 'n')]).toEqual(['t2', 'd3', 'r1', 'n1'])
})

test('a replaced entry is not standing, a later one that replaces it is', async () => {
  const s = stateOf({ t: 'decision', id: 'd1', pick: 'A', over: ['B'], reason: 'r' }, { t: 'decision', id: 'd2', pick: 'C', over: ['A'], reason: 'r', replaces: 'd1' })
  expect(standing(s).map(e => e.id)).toEqual(['d2'])
})

test('a file written twice is one path with count 2, and moves to newest', async () => {
  const s = stateOf({ t: 'did', kind: 'file', path: '/a' }, { t: 'did', kind: 'file', path: '/b' }, { t: 'did', kind: 'file', path: '/a' })
  expect(s.files.map(f => [f.path, f.count])).toEqual([
    ['/b', 1],
    ['/a', 2],
  ])
  expect(s.did).toEqual([])
})

test('typed prompts join with a newline for the quote check', async () => {
  expect(typedText(stateOf({ t: 'typed', text: 'one' }, { t: 'typed', text: 'two' }))).toBe('one\ntwo')
})
