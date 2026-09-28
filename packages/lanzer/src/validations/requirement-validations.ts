import { resolve as resolvePath } from 'node:path';
import type { AstNode, AstReflection, LangiumDocument } from 'langium';
import type {
    LanzerCampaignSpec,
    LanzerFileSpec,
    LanzerRequirementSpec
} from '../campaign/model.js';
import { renderSelector } from '../campaign/jobs.js';
import type { LanzerCampaignCheckValidationResult } from '../services/types.js';
import { evaluateSelector } from './selector-evaluator.js';

/**
 * Walks each generated document's AST and verifies the campaign's requirements.
 *
 * - SymbolRequirement: at least one node must match the selector
 * - CountRequirement:  at least N nodes must match
 * - ForbidRequirement: zero nodes must match
 *
 * Requirements scoped to a `fileAlias` evaluate against only that file's AST. Unscoped
 * campaign-level requirements aggregate matches across every generated file.
 */
export function validateRequirementsAgainstDocuments(
    campaign: LanzerCampaignSpec,
    documents: LangiumDocument[],
    reflection: AstReflection
): LanzerCampaignCheckValidationResult {
    const issues: string[] = [];
    const rootsByAlias = mapFileAliasesToRoots(campaign, documents, issues);

    for (const file of campaign.files) {
        const root = rootsByAlias.get(file.alias);
        if (!root) continue;
        for (const requirement of file.requirements) {
            issues.push(...checkRequirement(requirement, [root], file.alias, reflection));
        }
    }

    for (const requirement of campaign.requirements) {
        const scopeAlias = requirement.fileAlias;
        let roots: AstNode[];
        if (scopeAlias) {
            const root = rootsByAlias.get(scopeAlias);
            if (!root) {
                issues.push(`Requirement targets unknown file alias '${scopeAlias}': ${renderSelector(requirement.selector)}`);
                continue;
            }
            roots = [root];
        } else {
            roots = Array.from(rootsByAlias.values());
        }
        issues.push(...checkRequirement(requirement, roots, scopeAlias, reflection));
    }

    return { ok: issues.length === 0, issues };
}

function checkRequirement(
    requirement: LanzerRequirementSpec,
    roots: AstNode[],
    scopeAlias: string | undefined,
    reflection: AstReflection
): string[] {
    const unresolvedTypes = collectUnresolvedTypes(requirement);
    if (unresolvedTypes.length > 0) {
        return unresolvedTypes.map((rule) =>
            `Selector references unresolved rule '${rule}': ${renderSelector(requirement.selector)}`
        );
    }

    let total = 0;
    for (const root of roots) {
        total += evaluateSelector(requirement.selector, root, reflection).length;
    }

    const scope = scopeAlias ? ` in ${scopeAlias}` : '';
    const text = renderSelector(requirement.selector);

    switch (requirement.kind) {
        case 'symbol':
            if (total < 1) {
                return [`Required selector did not match any node${scope}: ${text}`];
            }
            return [];
        case 'count':
            if (total < requirement.count) {
                return [`Selector matched ${total} node(s) but at least ${requirement.count} were required${scope}: ${text}`];
            }
            return [];
        case 'forbid':
            if (total > 0) {
                return [`Forbidden selector matched ${total} node(s)${scope}: ${text}`];
            }
            return [];
        default: {
            const exhaustive: never = requirement;
            return [String(exhaustive)];
        }
    }
}

function mapFileAliasesToRoots(
    campaign: LanzerCampaignSpec,
    documents: LangiumDocument[],
    issues: string[]
): Map<string, AstNode> {
    const roots = new Map<string, AstNode>();
    const baseDir = resolveCampaignBaseDir(campaign);

    const docByPath = new Map<string, LangiumDocument>();
    for (const document of documents) {
        docByPath.set(normalizePath(document.uri.fsPath), document);
    }

    for (const file of campaign.files) {
        const absolute = resolvePath(baseDir, file.path);
        const doc = docByPath.get(normalizePath(absolute));
        if (!doc) {
            issues.push(`Generated file for '${file.alias}' was not found, or is not a document of the target language: ${absolute}`);
            continue;
        }
        roots.set(file.alias, doc.parseResult.value);
    }
    return roots;
}

function resolveCampaignBaseDir(campaign: LanzerCampaignSpec): string {
    if (campaign.workspaceRoot && campaign.baseDir) {
        return resolvePath(campaign.baseDir, campaign.workspaceRoot);
    }
    return campaign.workspaceRoot ?? campaign.baseDir ?? process.cwd();
}

function normalizePath(p: string): string {
    return resolvePath(p);
}

function collectUnresolvedTypes(requirement: LanzerRequirementSpec): string[] {
    const out: string[] = [];
    collectFromSelector(requirement.selector, out);
    return out;
}

function collectFromSelector(selector: import('../campaign/model.js').LanzerSelector, out: string[]): void {
    for (const part of selector.parts) {
        if (part.astType === '<unresolved>') {
            out.push(part.rule);
        }
        for (const predicate of part.predicates) {
            if (predicate.kind === 'crossRef' && predicate.targetAstType === '<unresolved>') {
                out.push(predicate.targetRule);
            }
        }
        for (const pseudo of part.pseudos) {
            collectFromSelector(pseudo.selector, out);
        }
    }
}

// Re-export so the file's only public callable is the orchestration helper.
export { evaluateSelector } from './selector-evaluator.js';

// Helper retained for symmetry — callers may want this when constructing fileAlias maps elsewhere.
export function getCampaignFileAbsolutePath(campaign: LanzerCampaignSpec, file: LanzerFileSpec): string {
    return resolvePath(resolveCampaignBaseDir(campaign), file.path);
}
