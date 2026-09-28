import { describe, expect, test } from 'vitest';
import {
    allowedClaudeTools,
    isInteractiveOnlyTool,
    isToolKindAllowed,
    permissionModeFor,
    permissiveLanzerPolicy,
    resolvePermissionPolicy
} from '../src/acp/permissions.js';

describe('permission policy', () => {
    test('no spec is the baseline, which has no shell', () => {
        const policy = resolvePermissionPolicy(undefined);
        expect(policy.source).toBe('baseline');
        expect([...policy.allowed].sort()).toEqual(['edit', 'other', 'read', 'search', 'think']);
        expect(isToolKindAllowed(policy, 'execute')).toBe(false);
    });

    test('a spec is taken literally', () => {
        const policy = resolvePermissionPolicy('read, edit');
        expect(policy.source).toBe('explicit');
        expect([...policy.allowed].sort()).toEqual(['edit', 'read']);
        expect(isToolKindAllowed(policy, 'search')).toBe(false);
    });

    test('unknown entries are collected, not dropped', () => {
        expect(resolvePermissionPolicy('read,exec').unknownEntries).toEqual(['exec']);
    });

    test('a call with no kind counts as other', () => {
        expect(isToolKindAllowed(resolvePermissionPolicy('read'), undefined)).toBe(false);
        expect(isToolKindAllowed(resolvePermissionPolicy('other'), null)).toBe(true);
    });

    test('a kind newer than this build is refused unless the policy is all', () => {
        expect(isToolKindAllowed(resolvePermissionPolicy(undefined), 'teleport')).toBe(false);
        expect(isToolKindAllowed(resolvePermissionPolicy('all'), 'teleport')).toBe(true);
        expect(isToolKindAllowed(permissiveLanzerPolicy(), 'teleport')).toBe(true);
    });

    test('the Claude tool allowlist follows the allowed kinds', () => {
        const tools = allowedClaudeTools(resolvePermissionPolicy(undefined));
        expect(tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill']));
        expect(tools).not.toContain('Bash');
        expect(allowedClaudeTools(resolvePermissionPolicy('read,execute'))).toContain('Bash');
        expect(allowedClaudeTools(permissiveLanzerPolicy())).toBeUndefined();
    });

    test('interactive-only tools are recognised by name', () => {
        expect(isInteractiveOnlyTool('Monitor')).toBe(true);
        expect(isInteractiveOnlyTool('Task')).toBe(true);
        expect(isInteractiveOnlyTool('Read')).toBe(false);
        expect(isInteractiveOnlyTool(undefined)).toBe(false);
    });

    test('edits are pre-accepted only when edit is allowed', () => {
        expect(permissionModeFor(resolvePermissionPolicy(undefined))).toBe('acceptEdits');
        expect(permissionModeFor(resolvePermissionPolicy('read'))).toBe('default');
    });
});
