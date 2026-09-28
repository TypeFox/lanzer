import { beforeAll, describe, expect, test } from 'vitest';
import { buildContainmentGraph, type ContainmentGraph } from '../src/grammar/reachability.js';
import { parseMini } from './helpers.js';

let graph: ContainmentGraph;

beforeAll(async () => {
    const { grammar } = await parseMini('');
    graph = buildContainmentGraph([grammar]);
});

describe('containment graph', () => {
    test('knows every type the grammar produces', () => {
        for (const type of ['Module', 'Fn', 'Param', 'Cls', 'Stmt', 'Call', 'Ret', 'ID']) {
            expect(graph.knownTypes).toContain(type);
        }
    });

    test('records assigned rule calls as direct children', () => {
        expect([...graph.directChildren.get('Module') ?? []]).toEqual(expect.arrayContaining(['Fn', 'Cls']));
        expect([...graph.directChildren.get('Fn') ?? []]).toEqual(expect.arrayContaining(['Param', 'Stmt']));
        expect([...graph.directChildren.get('Cls') ?? []]).toContain('Fn');
    });

    test('propagates through unassigned rule calls', () => {
        expect([...graph.directChildren.get('Stmt') ?? []]).toEqual(expect.arrayContaining(['Call', 'Ret']));
    });

    test('descendants are the transitive closure', () => {
        expect([...graph.descendants.get('Module') ?? []]).toEqual(expect.arrayContaining(['Fn', 'Cls', 'Param', 'Call', 'Ret']));
        expect([...graph.descendants.get('Cls') ?? []]).toContain('Ret');
    });

    test('a cross-reference is not containment', () => {
        expect(graph.descendants.get('Call') ?? new Set()).not.toContain('Fn');
    });
});
