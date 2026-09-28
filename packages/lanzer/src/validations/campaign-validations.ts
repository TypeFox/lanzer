import type { ValidationAcceptor, ValidationChecks } from 'langium';
import * as ast from '../generated/ast.js';
import { LanzerBaseValidation } from './base-validation.js';

/**
 * Semantic validation for Lanzer campaign specs.
 *
 * Catches authoring mistakes — duplicate paths, empty fields, malformed counts. Deeper
 * structural reachability checks against the imported host grammar live in
 * {@link ./selector-validation.ts}.
 */
export class LanzerCampaignValidator extends LanzerBaseValidation {
    getChecks(): ValidationChecks<ast.LanzerAstType> {
        return {
            Campaign: [
                this.checkCampaignHasFiles,
                this.checkUniqueArtifactNames,
                this.checkUniqueArtifactPaths,
                this.checkNonEmptyWorkspaceRoot
            ],
            CountRequirement: [this.checkPositiveCount, this.checkFileScopeInsideFile],
            SymbolRequirement: this.checkFileScopeInsideFile,
            ForbidRequirement: this.checkFileScopeInsideFile,
            GrammarImport: this.checkNonEmptyImportPath,
            Expectation: this.checkOutputExpectation
        };
    }

    checkCampaignHasFiles = (node: ast.Campaign, accept: ValidationAcceptor): void => {
        if (node.files.length === 0) {
            accept('error', 'A campaign must declare at least one file.', {
                node,
                property: 'files'
            });
        }
    };

    checkUniqueArtifactNames = (node: ast.Campaign, accept: ValidationAcceptor): void => {
        const seen = new Map<string, ast.FileSpec | ast.SupportFileSpec>();
        for (const artifact of [...node.files, ...node.supportFiles]) {
            if (seen.has(artifact.name)) {
                accept('error', `Duplicate file alias '${artifact.name}' in campaign '${node.name}'.`, {
                    node: artifact,
                    property: 'name'
                });
                continue;
            }
            seen.set(artifact.name, artifact);
        }
    };

    checkUniqueArtifactPaths = (node: ast.Campaign, accept: ValidationAcceptor): void => {
        const seen = new Map<string, ast.FileSpec | ast.SupportFileSpec>();
        for (const artifact of [...node.files, ...node.supportFiles]) {
            const normalizedPath = artifact.path.trim();
            if (seen.has(normalizedPath)) {
                accept('error', `Duplicate file path ${artifact.path} in campaign '${node.name}'.`, {
                    node: artifact,
                    property: 'path'
                });
                continue;
            }
            seen.set(normalizedPath, artifact);
        }
    };

    checkNonEmptyWorkspaceRoot = (node: ast.Campaign, accept: ValidationAcceptor): void => {
        if (node.workspaceRoot !== undefined && node.workspaceRoot.trim().length === 0) {
            accept('error', 'Workspace roots must not be empty.', {
                node,
                property: 'workspaceRoot'
            });
        }
    };

    checkPositiveCount = (node: ast.CountRequirement, accept: ValidationAcceptor): void => {
        if (node.count <= 0) {
            accept('error', 'Count requirements must be strictly positive.', {
                node,
                property: 'count'
            });
        }
    };

    /**
     * A requirement written inside a file block is checked against that file, so `in <other>` there
     * would say one thing and do another. Targeting another file belongs at campaign level.
     */
    checkFileScopeInsideFile = (
        node: ast.SymbolRequirement | ast.CountRequirement | ast.ForbidRequirement,
        accept: ValidationAcceptor
    ): void => {
        const owner = node.$container;
        const target = node.file?.ref;
        if (!ast.isFileSpec(owner) || !target || target === owner) {
            return;
        }
        accept('error', `A requirement inside file '${owner.name}' always applies to '${owner.name}'; declare it at campaign level to target '${target.name}'.`, {
            node,
            property: 'file'
        });
    };

    /**
     * An output check must be one that can be evaluated: a `matches` pattern has to compile, and a
     * check against the empty string says nothing — every output contains it, and exact empty
     * output is better written as `expect runs` plus a `not output matches "."`.
     */
    checkOutputExpectation = (node: ast.Expectation, accept: ValidationAcceptor): void => {
        if (node.runs || node.value === undefined) {
            return;
        }
        if (node.mode === 'matches') {
            try {
                new RegExp(node.value);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                accept('error', `Invalid regular expression: ${reason}`, { node, property: 'value' });
            }
            return;
        }
        if (node.value.length === 0) {
            accept('warning', node.mode === 'contains'
                ? 'Every output contains the empty string, so this check always passes.'
                : 'An exact check against empty output only passes if the program prints nothing; say so with `expect not output matches "."`.', {
                node,
                property: 'value'
            });
        }
    };

    checkNonEmptyImportPath = (node: ast.GrammarImport, accept: ValidationAcceptor): void => {
        if (node.path.trim().length === 0) {
            accept('error', 'Grammar import paths must not be empty.', {
                node,
                property: 'path'
            });
        }
    };
}
