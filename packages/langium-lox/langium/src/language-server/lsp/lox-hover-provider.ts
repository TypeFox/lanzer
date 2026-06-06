import { AstNode, MaybePromise } from "langium";
import { isClass, isNamedElement } from "../generated/ast.js";
import { isErrorType, typeToString } from "../type-system/descriptions.js";
import { inferType } from "../type-system/infer.js";
import { AstNodeHoverProvider } from "langium/lsp";

export class LoxHoverProvider extends AstNodeHoverProvider {
    protected getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        if (isClass(node)) {
            return `class ${node.name}${node.superClass ? ` ${node.superClass.$refText}` : ''}`;
        } else if (isNamedElement(node)) {
            const type = inferType(node, new Map());
            if (isErrorType(type)) {
                return undefined;
            }
            return `var ${node.name}: ${typeToString(type)}`;
        }
        return undefined;
    }
}
