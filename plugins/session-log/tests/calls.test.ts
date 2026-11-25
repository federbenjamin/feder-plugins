import { expect, test } from 'claude-code/testing'
import { callTool } from '../hooks/calls'
import { foldStore, storeLine } from '../hooks/store'
import { stateOf } from './world'

const NOW = new Date('2026-11-25T10:30:00.000Z')
const TYPED = { t: 'typed', text: 'keep the retry cap at 3, and never touch main' }

test('todo_close on an already closed id replies "already closed" and writes nothing', async () => {
  const state = stateOf({ t: 'todo.add', id: 't1', text: 'a' }, { t: 'todo.close', id: 't1' })
  expect(callTool(state, 'todo_close', { id: 't1' }, NOW)).toEqual({ events: [], reply: 'already closed' })
})

test('todo_close on an unknown id is an error that names the open ids', async () => {
  const state = stateOf({ t: 'todo.add', id: 't1', text: 'a' }, { t: 'todo.add', id: 't2', text: 'b' }, { t: 'todo.close', id: 't1' })
  const r = callTool(state, 'todo_close', { id: 't9' }, NOW)
  expect(r).toEqual({ refuse: 'no todo t9; open: t2' })
})

test('todo_close names "none" when nothing is open', async () => {
  expect(callTool(stateOf(), 'todo_close', { id: 't1' }, NOW)).toEqual({ refuse: 'no todo t1; open: none' })
})

test('todo_close of an open id appends one close event carrying the note', async () => {
  const r = callTool(stateOf({ t: 'todo.add', id: 't1', text: 'a' }), 'todo_close', { id: 't1', note: 'dropped' }, NOW)
  expect(r).toEqual({ events: [{ t: 'todo.close', at: NOW.toISOString(), id: 't1', note: 'dropped' }], reply: 'closed t1' })
})

test('todo_add returns the next short id after the todos already there, closed ones included', async () => {
  const state = stateOf({ t: 'todo.add', id: 't1', text: 'a' }, { t: 'todo.close', id: 't1' })
  expect(callTool(state, 'todo_add', { text: ' second ', tag: 'feat/x' }, NOW)).toEqual({
    events: [{ t: 'todo.add', at: NOW.toISOString(), id: 't2', text: 'second', tag: 'feat/x' }],
    reply: 'added t2',
  })
})

test('decide with an empty over is refused, whatever shape the empty takes', async () => {
  for (const over of [[], '', ['', '  '], undefined]) {
    const r = callTool(stateOf(), 'decide', { pick: 'A', over, reason: 'cheaper' }, NOW)
    expect(r).toEqual({ refuse: expect.stringContaining('over') })
  }
})

test('decide with an empty reason is refused', async () => {
  for (const reason of ['', '   ', undefined]) {
    expect(callTool(stateOf(), 'decide', { pick: 'A', over: ['B'], reason }, NOW)).toEqual({ refuse: expect.stringContaining('reason') })
  }
})

test('decide takes one alternative as a bare string and records it as a list', async () => {
  const r = callTool(stateOf(), 'decide', { pick: 'A', over: 'B', reason: 'faster' }, NOW)
  expect(r).toEqual({ events: [{ t: 'decision', at: NOW.toISOString(), id: 'd1', pick: 'A', over: ['B'], reason: 'faster' }], reply: 'recorded d1' })
})

test('decide that replaces an id which does not stand is refused, naming what stands', async () => {
  const state = stateOf({ t: 'decision', id: 'd1', pick: 'A', over: ['B'], reason: 'x' }, { t: 'decision', id: 'd2', pick: 'C', over: ['A'], reason: 'y', replaces: 'd1' })
  const r = callTool(state, 'decide', { pick: 'E', over: ['F'], reason: 'z', replaces: 'd1' }, NOW)
  expect(r).toEqual({ refuse: 'replaces: no standing decision or ruling d1; standing: d2' })
})

test('ruling is refused when the quote is not in what the operator typed, and the reply points to decide with by_session', async () => {
  const r = callTool(stateOf(TYPED), 'ruling', { quote: 'always rebase', meaning: 'rebase policy' }, NOW)
  expect(r).toEqual({ refuse: expect.stringContaining('decide with by_session') })
})

test('ruling with no typed prompt at all is refused', async () => {
  expect('refuse' in callTool(stateOf(), 'ruling', { quote: 'anything', meaning: 'm' }, NOW)).toBe(true)
})

test('ruling accepts a quote contained in a typed prompt, case and spacing aside', async () => {
  const r = callTool(stateOf(TYPED), 'ruling', { quote: 'Never  touch MAIN', meaning: 'main is off limits' }, NOW)
  expect(r).toEqual({ events: [{ t: 'ruling', at: NOW.toISOString(), id: 'r1', quote: 'Never  touch MAIN', meaning: 'main is off limits' }], reply: 'recorded r1' })
})

test('the same quote recorded twice writes nothing the second time', async () => {
  const state = stateOf(TYPED, { t: 'ruling', id: 'r1', quote: 'never touch main', meaning: 'm' })
  expect(callTool(state, 'ruling', { quote: 'never touch main', meaning: 'm' }, NOW)).toEqual({ events: [], reply: 'already recorded as r1' })
})

test('the same quote with a different tunable value is a new ruling, not a repeat', async () => {
  const state = stateOf(TYPED, { t: 'ruling', id: 'r1', quote: 'keep the retry cap at 3', meaning: 'cap', key: 'retries', value: '3' })
  const r = callTool(state, 'ruling', { quote: 'keep the retry cap at 3', meaning: 'cap', key: 'retries', value: '5' }, NOW)
  expect('events' in r && r.events.map(e => e.t)).toEqual(['ruling'])
})

test('ruling with only one of key and value is refused', async () => {
  expect(callTool(stateOf(TYPED), 'ruling', { quote: 'never touch main', meaning: 'm', key: 'retries' }, NOW)).toEqual({ refuse: expect.stringContaining('key and value') })
})

test('note with no text is refused and a note gets its own id counter', async () => {
  expect(callTool(stateOf(), 'note', { text: ' ' }, NOW)).toEqual({ refuse: 'note needs text' })
  const state = stateOf({ t: 'note', id: 'n1', text: 'x' }, { t: 'decision', id: 'd1', pick: 'A', over: ['B'], reason: 'r' })
  expect(callTool(state, 'note', { text: 'y' }, NOW)).toMatchObject({ reply: 'recorded n2' })
})

test('a store written from the events a call returned folds back to the same todos', async () => {
  const r = callTool(stateOf(), 'todo_add', { text: 'ship it' }, NOW)
  if (!('events' in r)) throw new Error('refused')
  expect(foldStore(r.events.map(storeLine).join('')).todos).toEqual([{ id: 't1', at: NOW.toISOString(), text: 'ship it' }])
})

// The operator says again what a later decision overturned: the repeat check must not see r1.
test('a ruling that repeats an earlier ruling a later decision replaced, called with replaces naming that decision, is a new ruling', async () => {
  const state = stateOf(
    { t: 'typed', text: 'use sqlite for the cache' },
    { t: 'typed', text: 'no, use sqlite' },
    { t: 'ruling', id: 'r1', quote: 'use sqlite', meaning: 'cache store' },
    { t: 'decision', id: 'd1', pick: 'postgres', over: ['sqlite'], reason: 'writers', replaces: 'r1' },
  )
  const r = callTool(state, 'ruling', { quote: 'use sqlite', meaning: 'cache store', replaces: 'd1' }, NOW)
  expect(r).toEqual({ events: [{ t: 'ruling', at: NOW.toISOString(), id: 'r2', quote: 'use sqlite', meaning: 'cache store', replaces: 'd1' }], reply: 'recorded r2' })
})

test('a ruling quote must sit inside one typed prompt, not join the end of one to the start of the next', async () => {
  const state = stateOf({ t: 'typed', text: 'is it ready? yes' }, { t: 'typed', text: 'merge nothing yet' })
  expect('refuse' in callTool(state, 'ruling', { quote: 'yes merge', meaning: 'm' }, NOW)).toBe(true)
  expect('events' in callTool(state, 'ruling', { quote: 'merge nothing', meaning: 'm' }, NOW)).toBe(true)
})
