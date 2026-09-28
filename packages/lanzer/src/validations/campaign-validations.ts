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
            CountRequirement: this.checkPositiveCount,
            GrammarImport: this.checkNonEmptyImportPath
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

    checkNonEmptyImportPath = (node: ast.GrammarImport, accept: ValidationAcceptor): void => {
        if (node.path.trim().length === 0) {
            accept('error', 'Grammar import paths must not be empty.', {
                node,
                property: 'path'
            });
        }
    };
}
