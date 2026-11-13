import { describe, expect, it } from 'vitest';
import { routeToolUnits } from '../../src/core/tools/routing';
import { ROUTING_CORPUS, ROUTING_SERVERS } from '../fixtures/routingCorpus';

const NATIVE = ['diagnostics', 'symbols', 'web', 'git', 'git.changes', 'git.remote'];
const MCP = ROUTING_SERVERS.map((server) => `mcp:${server.id}`);
const LOADABLE = [...NATIVE, ...MCP];
const route = (text: string, loadable = LOADABLE) =>
  routeToolUnits(text, loadable, { servers: ROUTING_SERVERS }).map((r) => r.unit);

describe('request routing corpus', () => {
  const outcomes = ROUTING_CORPUS.map(([text, expected]) => ({ text, expected, actual: route(text) }));

  /** Precision and recall per unit, with the requests behind every miss and overreach. */
  const stats = LOADABLE.map((unit) => {
    const hit = outcomes.filter((o) => o.expected.includes(unit) && o.actual.includes(unit)).length;
    const missed = outcomes.filter((o) => o.expected.includes(unit) && !o.actual.includes(unit)).map((o) => o.text);
    const extra = outcomes.filter((o) => !o.expected.includes(unit) && o.actual.includes(unit)).map((o) => o.text);
    return {
      unit,
      recall: hit + missed.length ? hit / (hit + missed.length) : 1,
      precision: hit + extra.length ? hit / (hit + extra.length) : 1,
      missed,
      extra,
    };
  });

  it.each(stats.filter((s) => NATIVE.includes(s.unit)))('finds native unit $unit (recall ≥ 90%, precision ≥ 75%)', (s) => {
    expect({ unit: s.unit, recall: s.recall >= 0.9, missed: s.missed }).toEqual({ unit: s.unit, recall: true, missed: s.missed });
    expect({ unit: s.unit, precision: s.precision >= 0.75, extra: s.extra }).toEqual({ unit: s.unit, precision: true, extra: s.extra });
  });

  it.each(stats.filter((s) => MCP.includes(s.unit)))('finds MCP unit $unit (recall ≥ 75%, precision ≥ 90%)', (s) => {
    expect({ unit: s.unit, recall: s.recall >= 0.75, missed: s.missed }).toEqual({ unit: s.unit, recall: true, missed: s.missed });
    expect({ unit: s.unit, precision: s.precision >= 0.9, extra: s.extra }).toEqual({ unit: s.unit, precision: true, extra: s.extra });
  });

  it('loads nothing extra for at least 90% of the requests that need nothing', () => {
    const plain = outcomes.filter((o) => o.expected.length === 0);
    const clean = plain.filter((o) => o.actual.length === 0);
    expect({ share: clean.length / plain.length >= 0.9, loaded: plain.filter((o) => o.actual.length).map((o) => [o.text, o.actual]) }).toMatchObject({ share: true });
  });
});

describe('request routing', () => {
  it('only returns loadable units, with the units they build on first', () => {
    expect(route('Committa e pusha tutto')).toEqual(['git', 'git.changes', 'git.remote']);
    expect(route('Committa e pusha tutto', ['git.changes'])).toEqual(['git.changes']);
    expect(route('Take a screenshot of the login page', NATIVE)).toEqual([]);
  });

  it('explains each unit for the log', () => {
    expect(routeToolUnits('Fai push del branch, poi leggi https://example.com/x', LOADABLE)).toEqual([
      { unit: 'web', reason: 'URL https://example.com/x' },
      { unit: 'git', reason: '"branch"' },
      { unit: 'git.remote', reason: '"Fai push"' },
    ]);
    expect(routeToolUnits('Stage and commit everything', LOADABLE)).toEqual([
      { unit: 'git', reason: '"commit"' },
      { unit: 'git.changes', reason: '"and commit"' },
    ]);
  });

  it('loads the units a slash command declares even when its text names none', () => {
    expect(routeToolUnits('Review the attached code', LOADABLE, { commandUnits: ['git', 'nope'] })).toEqual([
      { unit: 'git', reason: 'command' },
    ]);
  });

  it('sends local URLs to the browser, never to the Web tool, and ignores words inside URLs', () => {
    expect(route('Open http://localhost:4200/settings and check the toggle')).toEqual(['mcp:playwright']);
    expect(route('Fetch http://192.168.1.20/status')).toEqual(['mcp:playwright']);
    expect(route('Fetch http://192.168.1.20/status', NATIVE)).toEqual([]);
    expect(route('Open http://[::1]:8080/', NATIVE)).toEqual([]);
    expect(route('Read https://gitlab.com/group/project/-/merge_requests/1')).toEqual(['web']);
  });

  it('recognizes a custom server by the words of its name, but not by generic ones', () => {
    const servers = [{ id: 'notes-server', name: 'Team notes server' }];
    expect(routeToolUnits('Add this to the team notes', ['mcp:notes-server'], { servers })).toEqual([
      { unit: 'mcp:notes-server', reason: '"team"' },
    ]);
    expect(routeToolUnits('Restart the dev server', ['mcp:notes-server'], { servers })).toEqual([]);
  });
});
