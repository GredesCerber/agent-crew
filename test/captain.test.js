// Captain handover: the repo owner's rule, handoffs by the captain only, the automatic fallback. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handoverPolicy, explainPolicy, handoffProblem, actingCaptain, hasCaptainPowers, handoffMarker, handbackMarker } from '../src/core/captain.js';
import captainCmds, { policyFrom } from '../src/commands/captain.js';
import { canDecide, ideaBody, IDEA_LABEL } from '../src/core/ideas.js';
import { actionArgs } from '../src/core/board.js';
import { digestModel, renderDigest } from '../src/core/digest.js';
import { findCommand } from '../src/core/registry.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const cmd = (name) => captainCmds.find((c) => c.name === name);
const cfg = (handover) => ({ captain: 'Cap', captain_handover: handover });
const byCap = (body) => ({ body, author: { login: 'cap' }, authorAssociation: 'OWNER' });
const by = (login, body) => ({ body, author: { login }, authorAssociation: 'MEMBER' });
const until = (h) => new Date(NOW + h * 3_600_000).toISOString();

test('policy: off by default; deputies normalized; fallback only with a mode that allows handover', () => {
  assert.deepEqual(handoverPolicy({}), { mode: 'off', deputies: [], fallback_hours: 0 });
  assert.deepEqual(handoverPolicy(cfg({ mode: 'deputies', deputies: ['@ami', 'ami', 'puny'], fallback_hours: 3 })), { mode: 'deputies', deputies: ['ami', 'puny'], fallback_hours: 3 });
  assert.equal(handoverPolicy(cfg({ mode: 'off', deputies: ['ami'], fallback_hours: 3 })).fallback_hours, 0);
  assert.equal(handoverPolicy(cfg({ mode: 'weird' })).mode, 'off');
});

test('the rule in plain words for the repo owner, per mode', () => {
  assert.match(explainPolicy(cfg({ mode: 'off' })).join(' '), /Handover: off\. Nobody else can act as captain/);
  const dep = explainPolicy(cfg({ mode: 'deputies', deputies: ['ami'], fallback_hours: 2 })).join(' ');
  assert.match(dep, /deputies only \(@ami\)/);
  assert.match(dep, /no activity for 2 h, @ami acts as captain/);
  assert.match(explainPolicy(cfg({ mode: 'team' })).join(' '), /anyone with write access/);
  assert.match(explainPolicy({}).join(' '), /crew captain policy/);
});

test('who the role may be handed to depends on the mode', () => {
  assert.match(handoffProblem('ami', cfg({ mode: 'off' })), /off/);
  assert.equal(handoffProblem('@Ami', cfg({ mode: 'deputies', deputies: ['ami'] })), null);
  assert.match(handoffProblem('puny', cfg({ mode: 'deputies', deputies: ['ami'] })), /not a deputy/);
  assert.equal(handoffProblem('puny', cfg({ mode: 'team' }), { members: ['puny', 'ami'] }), null);
  assert.match(handoffProblem('stranger', cfg({ mode: 'team' }), { members: ['puny'] }), /no write access/);
  assert.match(handoffProblem('cap', cfg({ mode: 'team' })), /captain already/);
});

test('acting captain: only the captain\'s own handoff counts, until it ends or the captain is back', () => {
  const c = cfg({ mode: 'deputies', deputies: ['ami'] });
  const act = (comments, extra = {}) => actingCaptain({ config: c, comments, now: NOW, ...extra });
  assert.deepEqual(act([byCap(handoffMarker({ to: 'ami', until: until(2) }))]), { login: 'ami', why: 'handoff', until: until(2) });
  assert.equal(act([by('ami', handoffMarker({ to: 'ami', until: until(2) }))]).login, 'Cap', 'a deputy cannot hand it to themself');
  assert.equal(act([byCap(handoffMarker({ to: 'ami', until: until(-1) }))]).login, 'Cap', 'expired');
  assert.equal(act([byCap(handoffMarker({ to: 'ami', until: until(2) })), byCap(handbackMarker())]).login, 'Cap', 'back');
  assert.equal(act([byCap(handoffMarker({ to: 'puny', until: until(2) }))]).login, 'Cap', 'not allowed by the rule (e.g. the rule changed since)');
  assert.equal(actingCaptain({ config: cfg({ mode: 'off' }), comments: [byCap(handoffMarker({ to: 'ami', until: until(2) }))], now: NOW }).login, 'Cap', 'off ignores handoffs');
});

test('automatic fallback: the first deputy acts after N quiet hours; unknown activity never triggers it', () => {
  const c = cfg({ mode: 'deputies', deputies: ['ami', 'puny'], fallback_hours: 3 });
  assert.deepEqual(actingCaptain({ config: c, captainActiveAt: new Date(NOW - 4 * 3_600_000).toISOString(), now: NOW }), { login: 'ami', why: 'fallback' });
  assert.equal(actingCaptain({ config: c, captainActiveAt: new Date(NOW - 2 * 3_600_000).toISOString(), now: NOW }).login, 'Cap');
  assert.equal(actingCaptain({ config: c, captainActiveAt: null, now: NOW }).login, 'Cap');
});

test('captain powers: the captain always, the acting captain too, nobody else', () => {
  const c = cfg({ mode: 'deputies', deputies: ['ami'] });
  assert.ok(hasCaptainPowers('CAP', c, null));
  assert.ok(hasCaptainPowers('ami', c, { login: 'ami', why: 'handoff' }));
  assert.ok(!hasCaptainPowers('ami', c, { login: 'Cap', why: 'captain' }));
  assert.ok(hasCaptainPowers('anyone', {}, null), 'no captain: anyone');
  assert.ok(canDecide('ami', c, { login: 'ami', why: 'fallback' }), 'ideas follow the acting captain');
  const idea = { number: 5, title: 'Idea: x', labels: [{ name: IDEA_LABEL }], body: ideaBody({ text: 'x', from: 'claude@pc' }) };
  assert.ok(actionArgs({ op: 'idea', value: 'accept' }, idea, { login: 'ami', config: c, acting: { login: 'ami', why: 'handoff' } }).args);
  assert.match(actionArgs({ op: 'idea', value: 'accept' }, idea, { login: 'ami', config: c, acting: null }).error, /acting captain/);
});

test('crew captain policy: validated flags; the repo owner can switch between rules', () => {
  assert.deepEqual(policyFrom({ mode: 'deputies', deputies: '@ami, puny', fallback_hours: 3 }).value, { mode: 'deputies', deputies: ['ami', 'puny'], fallback_hours: 3 });
  assert.match(policyFrom({ mode: 'deputies' }).error, /at least one deputy/);
  assert.match(policyFrom({ mode: 'team', fallback_hours: 2 }).error, /needs at least one deputy/);
  assert.match(policyFrom({ mode: 'later' }).error, /must be one of/);
  assert.deepEqual(policyFrom({ mode: 'off' }, { mode: 'deputies', deputies: ['ami'], fallback_hours: 3 }).value, { mode: 'off', deputies: ['ami'], fallback_hours: 0 });
  const r = cmd('captain policy').run({ mode: 'team' }, { config: cfg({ mode: 'off' }), login: 'cap' });
  assert.equal(r.artifacts.captain_handover.mode, 'team');
  assert.ok(r.next_actions.some((a) => /protected file/.test(a)));
  assert.equal(cmd('captain policy').run({ mode: 'team' }, { config: cfg({ mode: 'off' }), login: 'ami' }).error.code, 'not_captain');
});

test('crew captain handoff / back: captain only, within the rule, recorded in the log issue', () => {
  const calls = [];
  const gh = (args) => (calls.push(args), { code: 0, stdout: args[1] === 'create' ? 'https://github.com/o/r/issues/12\n' : '' });
  const c = cfg({ mode: 'deputies', deputies: ['ami'] });
  assert.equal(cmd('captain handoff').run({ to: '@ami' }, { config: c, login: 'ami', gh }).error.code, 'not_captain');
  assert.equal(cmd('captain handoff').run({ to: '@puny' }, { config: c, login: 'cap', gh, issue: null }).error.code, 'handoff_not_allowed');
  assert.equal(calls.length, 0);
  const r = cmd('captain handoff').run({ to: '@ami', hours: 500 }, { config: c, login: 'cap', gh, issue: null, now: NOW });
  assert.equal(r.artifacts.until, until(72), 'capped at 72 h');
  assert.deepEqual(calls[0].slice(0, 2), ['issue', 'create']);
  assert.match(calls[1].at(-1), /<!-- crew:handoff to=ami until=/);
  calls.length = 0;
  assert.equal(cmd('captain back').run({}, { config: c, login: 'cap', gh, issue: { number: 12 } }).status, 'success');
  assert.match(calls[0].at(-1), /<!-- crew:handback -->/);
  const s = cmd('captain').run({}, { config: c, acting: { login: 'ami', why: 'handoff', until: until(2) } });
  assert.match(s.summary, /@ami \(handed over until/);
  assert.equal(findCommand(['captain', 'handoff', '@ami']).name, 'captain handoff');
});

test('the digest says who acts as captain, without pinging anyone', () => {
  const m = digestModel({ config: cfg({ mode: 'deputies', deputies: ['ami'] }), acting: { login: 'ami', why: 'handoff', until: until(2) }, now: NOW });
  const md = renderDigest(m, { now: NOW });
  assert.match(md, /\*\*Captain:\*\* @​Cap; \*\*acting now:\*\* @​ami \(handed over until/);
  assert.doesNotMatch(md, /@(?=[\w-])/);
  assert.match(renderDigest(digestModel({ config: { captain: 'Cap' }, now: NOW }), { now: NOW }), /\*\*Captain:\*\* @​Cap\n/);
});
