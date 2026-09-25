/**
 * Narrowing helpers for values whose runtime shape is wider than their static type.
 *
 * Lanzer reads two kinds of loosely-typed data: AST nodes reached by a property name computed at
 * runtime, and payloads from an ACP agent it does not control. Both are places where a type
 * assertion would compile and then be wrong at runtime with nothing to catch it. Every helper
 * here checks what it claims, so a shape that does not hold takes the fallback branch instead of
 * becoming a `TypeError` further down.
 */
import type { AstNode, Reference } from 'langium';
import { isAstNode, isReference } from 'langium';

/** A non-null, non-array object whose properties can be read by a computed key. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An AST node's `$type` as the plain string it is at runtime.
 *
 * Langium types `$type` as a union of the rules it generated, but a parsed tree also carries
 * nodes the generated union does not name — `ParameterReference` and `NamedArgument` among them.
 * Comparing the union against one of those is a compile error on a check that is doing real work,
 * so this widens the value rather than asserting it into a different shape.
 */
export function astTypeName(node: AstNode): string {
    return node.$type;
}

/**
 * Read one property of an AST node by a name that is only known at runtime.
 *
 * Selectors name the property they test (`[name="x"]`), so the key cannot be checked statically.
 * Returning `unknown` keeps that honest: every caller has to establish the type it wants.
 */
export function readAstProperty(node: AstNode, property: string): unknown {
    return isRecord(node) ? node[property] : undefined;
}

/** Whether a node carries a usable `name`, for the several places that report one. */
export function hasStringName(node: AstNode): node is AstNode & { name: string } {
    return isRecord(node) && typeof node.name === 'string';
}

/** A Langium cross-reference, narrowed from an arbitrary property value. */
export function isAstReference(value: unknown): value is Reference {
    return isReference(value);
}

/** An AST node, narrowed from an arbitrary property value. */
export function isAstNodeValue(value: unknown): value is AstNode {
    return isAstNode(value);
}

/**
 * Narrow a string to one of a fixed set of literals.
 *
 * The grammar constrains these values, but the parser hands them back as plain strings, and the
 * two only agree while the grammar and the model stay in step. Checking closes that gap: a
 * literal the model no longer lists takes the caller's fallback instead of being admitted as a
 * member of a union it does not belong to.
 */
export function asLiteral<T extends string>(
    value: string | undefined,
    allowed: readonly T[]
): T | undefined {
    return allowed.find((candidate) => candidate === value);
}

/**
 * An LSP diagnostic's `code`, as a string, when the host set one.
 *
 * LSP types it as `integer | string | undefined` and most Langium languages leave it undefined —
 * it is optional in the spec and `langium-cli` does not scaffold it. Numeric codes are rendered as
 * decimal strings so everything downstream groups on one type, and an empty string is treated as
 * absent because it is a code nobody can act on.
 */
export function diagnosticCode(code: string | number | undefined | null): string | undefined {
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code.length > 0) return code;
    return undefined;
}
